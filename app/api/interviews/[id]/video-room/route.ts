import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withAuth, AuthenticatedRequest } from "@/lib/middleware"

/* =====================================================
   ENV GUARD
===================================================== */


/* =====================================================
   POST /api/interviews/[id]/video-room
   Creates a Daily.co room for the interview
   Returns the room URL — same URL for both candidate
   and interviewer (Daily handles access via tokens)
===================================================== */

async function postHandler(
  req: AuthenticatedRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: interviewId } = await params
    const { userId, role }    = req.user

    const interview = await prisma.interview.findUnique({
      where:  { id: interviewId },
      select: {
        id:           true,
        title:        true,
        status:       true,
        endTime:      true,
        candidateId:  true,
        interviewerId: true,
        videoRecording: true,
      },
    })

    if (!interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 })
    }

    const isParticipant =
      interview.candidateId   === userId ||
      interview.interviewerId === userId

    if (!isParticipant && role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (interview.status === "CANCELLED") {
      return NextResponse.json({ error: "Interview is cancelled" }, { status: 400 })
    }

    /* -------------------------
       If room URL already saved — return it
    -------------------------- */

    if (interview.videoRecording?.startsWith("https://")) {
      return NextResponse.json({ success: true, url: interview.videoRecording })
    }

    /* -------------------------
       Create Daily.co room
       Room name = interview ID (stable, idempotent)
       Expires 1 hour after scheduled end time
    -------------------------- */

    const expiryTs = Math.floor(
      (new Date(interview.endTime).getTime() + 60 * 60 * 1000) / 1000
    )

    const roomName = `truehire-${interviewId}`

    const dailyRes = await fetch("https://api.daily.co/v1/rooms", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${process.env.DAILY_API_KEY}`,
      },
      body: JSON.stringify({
        name:       roomName,
        privacy:    "private",
        properties: {
          exp:                     expiryTs,
          enable_recording:        "cloud",
          max_participants:        5,
          enable_prejoin_ui:       false,
          enable_knocking:         false,
          enable_screenshare:      true,
          enable_chat:             false, // we have our own chat
          lang:                    "en",
        },
      }),
    })

    let roomUrl: string

    if (dailyRes.ok) {
      const room = await dailyRes.json()
      roomUrl    = room.url
    } else if (dailyRes.status === 409) {
      // Room already exists — fetch it
      const getRes = await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` },
      })
      const room = await getRes.json()
      roomUrl    = room.url
    } else {
      const err = await dailyRes.json()
      throw new Error(err.error || "Failed to create video room")
    }

    /* -------------------------
       Save room URL to interview
    -------------------------- */

    await prisma.interview.update({
      where: { id: interviewId },
      data:  { videoRecording: roomUrl },
    })

    return NextResponse.json({ success: true, url: roomUrl })
  } catch (error) {
    console.error("Video room error:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Failed to create video room" }, { status: 500 })
  }
}

export const POST = withAuth(postHandler)