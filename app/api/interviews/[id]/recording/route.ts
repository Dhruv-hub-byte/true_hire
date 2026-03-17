import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withAuth, AuthenticatedRequest } from "@/lib/middleware"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"

/* =====================================================
   ENV GUARD
   Cloudflare R2 uses the S3-compatible API
   Get these from: Cloudflare Dashboard → R2 → Manage API Tokens
===================================================== */


/* =====================================================
   R2 CLIENT
   R2 is S3-compatible — uses the same @aws-sdk/client-s3
   No extra package needed
===================================================== */

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

/* =====================================================
   RATE LIMITING
===================================================== */

const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX = 10
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  if (entry.count >= RATE_LIMIT_MAX) return true
  entry.count++
  return false
}

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  )
}

/* =====================================================
   CONSTANTS
===================================================== */

const MAX_FILE_SIZE      = 100 * 1024 * 1024 // 100MB
const ALLOWED_MIME_TYPES = ["video/webm", "video/mp4", "video/ogg", "video/quicktime"]
const ALLOWED_EXTENSIONS = [".webm", ".mp4", ".ogg", ".mov"]

function getExtension(filename: string): string {
  return filename.slice(filename.lastIndexOf(".")).toLowerCase()
}

/* =====================================================
   UPLOAD TO R2
===================================================== */

async function uploadToR2(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const key = `recordings/${filename}`

  await r2.send(
    new PutObjectCommand({
      Bucket:      process.env.R2_BUCKET!,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
    })
  )

  // R2_PUBLIC_URL is your bucket's public domain
  // e.g. https://pub-xxxxxxxx.r2.dev  or your custom domain
  return `${process.env.R2_PUBLIC_URL}/${key}`
}

/* =====================================================
   POST /api/interviews/[id]/recording
===================================================== */

async function postHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authReq = req as AuthenticatedRequest

  if (!authReq.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const ip = getClientIp(req)
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many requests. Please slow down." },
        { status: 429 }
      )
    }

    const { id: interviewId } = await params

    /* -------------------------
       Validate interview
    -------------------------- */

    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: { id: true, candidateId: true, interviewerId: true, status: true },
    })

    if (!interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 })
    }

    if (interview.status !== "IN_PROGRESS" && interview.status !== "COMPLETED") {
      return NextResponse.json(
        { error: "Recordings can only be uploaded for active or completed interviews" },
        { status: 400 }
      )
    }

    /* -------------------------
       Access control
    -------------------------- */

    const { userId, role } = authReq.user
    const isParticipant =
      interview.candidateId === userId || interview.interviewerId === userId

    if (!isParticipant && role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    /* -------------------------
       Parse + validate file
    -------------------------- */

    const formData = await req.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 })
    }

    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Invalid file type. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}` },
        { status: 400 }
      )
    }

    const ext = getExtension(file.name)
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        { error: `Invalid extension. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` },
        { status: 400 }
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large (max 100MB)" },
        { status: 400 }
      )
    }

    /* -------------------------
       Upload to R2
    -------------------------- */

    const bytes    = await file.arrayBuffer()
    const buffer   = Buffer.from(bytes)
    const filename = `${interviewId}-${Date.now()}${ext}`
    const url      = await uploadToR2(buffer, filename, file.type)

    /* -------------------------
       Save URL to DB
    -------------------------- */

    await prisma.interview.update({
      where: { id: interviewId },
      data:  { videoRecording: url },
    })

    return NextResponse.json({ success: true, url })
  } catch (error) {
    console.error(
      "Recording upload error:",
      error instanceof Error ? error.message : error
    )
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}

export const POST = withAuth(postHandler)