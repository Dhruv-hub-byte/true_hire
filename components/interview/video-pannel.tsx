"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useAuth } from "@/lib/auth-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Camera, CameraOff, Mic, MicOff,
  Loader2, Circle, Square, AlertCircle,
  CheckCircle2, Video,
} from "lucide-react"

type UploadStatus = "idle" | "uploading" | "success" | "error"

interface Props {
  interviewId: string
  userName?: string
}

export default function VideoPanel({ interviewId, userName = "Participant" }: Props) {
  const { accessToken } = useAuth()

  // Local proctoring refs
  const videoRef    = useRef<HTMLVideoElement | null>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef   = useRef<Blob[]>([])
  const durationRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)
  const [cameraOn,     setCameraOn]     = useState(false)
  const [micOn,        setMicOn]        = useState(false)
  const [recording,    setRecording]    = useState(false)
  const [duration,     setDuration]     = useState(0)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle")

  // Jitsi call state
  const [callActive,   setCallActive]   = useState(false)
  const jitsiRef       = useRef<HTMLDivElement | null>(null)
  const jitsiApiRef    = useRef<any>(null)

  /* =====================================================
     INIT LOCAL CAMERA (proctoring preview)
  ===================================================== */

  const initMedia = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true },
      })

      streamRef.current = mediaStream
      setCameraOn(true)
      setMicOn(true)

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Permission denied"
      setError(
        msg.includes("Permission")
          ? "Camera or microphone access denied. Please allow access in browser settings."
          : "Failed to access camera or microphone."
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    initMedia()
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (durationRef.current) clearInterval(durationRef.current)
      jitsiApiRef.current?.dispose()
    }
  }, [initMedia])

  useEffect(() => {
    if (videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [loading])

  /* =====================================================
     JITSI CALL
  ===================================================== */

  const startCall = useCallback(() => {
    if (!jitsiRef.current) return

    // Load Jitsi script dynamically if not loaded
    const startJitsi = () => {
      const roomName = `truehire-${interviewId}`

      const api = new (window as any).JitsiMeetExternalAPI("meet.jit.si", {
        roomName,
        parentNode: jitsiRef.current,
        width:      "100%",
        height:     320,
        userInfo:   { displayName: userName },
        configOverwrite: {
          prejoinPageEnabled:       false,
          startWithAudioMuted:      false,
          startWithVideoMuted:      false,
          disableDeepLinking:       true,
          enableWelcomePage:        false,
          disableInviteFunctions:   true,
        },
        interfaceConfigOverwrite: {
          SHOW_JITSI_WATERMARK:     false,
          SHOW_WATERMARK_FOR_GUESTS: false,
          TOOLBAR_BUTTONS: [
            "microphone", "camera", "hangup",
            "tileview", "fullscreen", "screensharing",
          ],
        },
      })

      jitsiApiRef.current = api
      setCallActive(true)

      api.addEventListener("videoConferenceLeft", () => {
        setCallActive(false)
        jitsiApiRef.current = null
      })
    }

    if ((window as any).JitsiMeetExternalAPI) {
      startJitsi()
    } else {
      const script = document.createElement("script")
      script.src   = "https://meet.jit.si/external_api.js"
      script.onload = startJitsi
      document.head.appendChild(script)
    }
  }, [interviewId, userName])

  const endCall = useCallback(() => {
    jitsiApiRef.current?.executeCommand("hangup")
    jitsiApiRef.current?.dispose()
    jitsiApiRef.current = null
    setCallActive(false)
  }, [])

  /* =====================================================
     RECORDING (local proctoring)
  ===================================================== */

  const startRecording = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return

    chunksRef.current = []
    setDuration(0)
    setUploadStatus("idle")

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : MediaRecorder.isTypeSupported("video/webm")
      ? "video/webm"
      : ""

    const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    mediaRecorder.onstop = async () => {
      if (chunksRef.current.length === 0) return
      const blob = new Blob(chunksRef.current, { type: mimeType || "video/webm" })
      await uploadRecording(blob)
      chunksRef.current = []
    }

    mediaRecorder.start(5000)
    recorderRef.current = mediaRecorder
    setRecording(true)

    durationRef.current = setInterval(() => setDuration((d) => d + 1), 1000)
  }, [])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
    recorderRef.current = null
    setRecording(false)
    if (durationRef.current) {
      clearInterval(durationRef.current)
      durationRef.current = null
    }
  }, [])

  /* =====================================================
     UPLOAD
  ===================================================== */

  const uploadRecording = async (blob: Blob) => {
    try {
      setUploadStatus("uploading")
      const formData = new FormData()
      formData.append("file", blob, `recording-${interviewId}-${Date.now()}.webm`)

      const res = await fetch(`/api/interviews/${interviewId}/recording`, {
        method: "POST",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        credentials: "include",
        body: formData,
      })

      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      setUploadStatus("success")
    } catch (err) {
      console.error("Recording upload failed:", err instanceof Error ? err.message : err)
      setUploadStatus("error")
    }
  }

  /* =====================================================
     TOGGLES
  ===================================================== */

  const toggleCamera = () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setCameraOn(track.enabled)
  }

  const toggleMic = () => {
    const track = streamRef.current?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setMicOn(track.enabled)
  }

  const formatDuration = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`

  /* =====================================================
     UI
  ===================================================== */

  return (
    <Card className="bg-slate-900/80 border-slate-700/50 rounded-2xl shadow-xl">

      {/* Header */}
      <CardHeader className="py-4 px-5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-white text-sm font-semibold flex items-center gap-2">
            <Camera className="w-4 h-4 text-indigo-400" />
            Video & Proctoring
          </CardTitle>

          {recording ? (
            <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium">
              <Circle className="w-2.5 h-2.5 fill-red-500 animate-pulse" />
              REC {formatDuration(duration)}
            </div>
          ) : uploadStatus === "uploading" ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs">
              <Loader2 className="w-3 h-3 animate-spin" /> Uploading...
            </div>
          ) : uploadStatus === "success" ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
              <CheckCircle2 className="w-3 h-3" /> Uploaded
            </div>
          ) : uploadStatus === "error" ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
              <AlertCircle className="w-3 h-3" /> Upload Failed
            </div>
          ) : (
            <div className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-500 text-xs">
              Not Recording
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-5 pb-5">

        {loading && (
          <div className="flex flex-col items-center justify-center h-48 gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
            <p className="text-slate-400 text-xs">Requesting camera access...</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-red-400" />
            </div>
            <p className="text-red-400 text-sm">{error}</p>
            <Button size="sm" variant="outline" onClick={initMedia}
              className="h-9 rounded-xl border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700 hover:text-white text-xs">
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ── Local proctoring preview ── */}
            <div className="relative rounded-xl overflow-hidden bg-black aspect-video">
              <video ref={videoRef} autoPlay muted playsInline
                className={`w-full h-full object-cover transition-opacity ${cameraOn ? "opacity-100" : "opacity-0"}`}
              />
              {!cameraOn && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
                  <div className="flex flex-col items-center gap-2">
                    <CameraOff className="w-8 h-8 text-slate-600" />
                    <p className="text-slate-500 text-xs">Camera disabled</p>
                  </div>
                </div>
              )}
              <div className="absolute top-2 left-2 flex gap-1.5">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${
                  cameraOn ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-red-500/10 border-red-500/20 text-red-400"
                }`}>
                  <Camera className="w-2.5 h-2.5" />{cameraOn ? "ON" : "OFF"}
                </span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border ${
                  micOn ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-red-500/10 border-red-500/20 text-red-400"
                }`}>
                  <Mic className="w-2.5 h-2.5" />{micOn ? "ON" : "OFF"}
                </span>
              </div>
              {recording && (
                <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-red-600/80 text-white text-xs font-medium">
                  <Circle className="w-2 h-2 fill-white animate-pulse" />
                  {formatDuration(duration)}
                </div>
              )}
            </div>

            {/* ── Jitsi call embed ── */}
            <div
              ref={jitsiRef}
              className={`rounded-xl overflow-hidden border border-slate-700/50 ${callActive ? "block" : "hidden"}`}
            />

            {/* ── Controls ── */}
            <div className="space-y-2.5">

              {/* Video call button */}
              {!callActive ? (
                <Button onClick={startCall}
                  className="w-full h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white gap-2 text-sm">
                  <Video className="w-4 h-4" /> Join Video Call
                </Button>
              ) : (
                <Button onClick={endCall} variant="outline"
                  className="w-full h-10 rounded-xl border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 gap-2 text-sm">
                  <Square className="w-3.5 h-3.5 fill-current" /> End Call
                </Button>
              )}

              {/* Recording control */}
              {!recording ? (
                <Button onClick={startRecording} disabled={uploadStatus === "uploading"}
                  className="w-full h-10 rounded-xl bg-red-600 hover:bg-red-500 text-white gap-2 text-sm">
                  <Circle className="w-3.5 h-3.5 fill-white" /> Start Recording
                </Button>
              ) : (
                <Button onClick={stopRecording} variant="outline"
                  className="w-full h-10 rounded-xl border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 gap-2 text-sm">
                  <Square className="w-3.5 h-3.5 fill-current" /> Stop Recording
                </Button>
              )}

              {/* Camera + Mic toggles */}
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={toggleCamera}
                  className="h-10 rounded-xl border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700 hover:text-white gap-2 text-xs">
                  {cameraOn ? <><CameraOff className="w-3.5 h-3.5" /> Disable Cam</> : <><Camera className="w-3.5 h-3.5" /> Enable Cam</>}
                </Button>
                <Button variant="outline" onClick={toggleMic}
                  className="h-10 rounded-xl border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700 hover:text-white gap-2 text-xs">
                  {micOn ? <><MicOff className="w-3.5 h-3.5" /> Mute</> : <><Mic className="w-3.5 h-3.5" /> Unmute</>}
                </Button>
              </div>

              {uploadStatus === "error" && (
                <p className="text-xs text-red-400 text-center">
                  Recording upload failed. Interview data saved locally.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}