import { NextRequest, NextResponse } from "next/server"
import { AccessToken } from "livekit-server-sdk"
import { prisma } from "@/lib/prisma"
import { withAuth, AuthenticatedRequest } from "@/lib/middleware"

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
        id:            true,
        title:         true,
        status:        true,
        endTime:       true,
        candidateId:   true,
        interviewerId: true,
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

    // Generate token
    const roomName = `truehire-${interviewId}`
    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: userId, ttl: "4h" }
    )
    at.addGrant({
      room:           roomName,
      roomJoin:       true,
      canPublish:     true,
      canSubscribe:   true,
      canPublishData: true,
    })

    const token = await at.toJwt()
    const url   = process.env.NEXT_PUBLIC_LIVEKIT_URL!

    return NextResponse.json({ success: true, token, url, roomName })
  } catch (error) {
    console.error("Video room error:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Failed to create video room" }, { status: 500 })
  }
}

export const POST = withAuth(postHandler)