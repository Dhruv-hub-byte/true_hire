import { NextRequest, NextResponse } from "next/server"
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken"
import crypto from "crypto"
import { prisma } from "@/lib/prisma"
import { generateRefreshToken } from "@/lib/auth"

/* =====================================================
   ENV GUARD
===================================================== */


/* =====================================================
   TYPES
===================================================== */

interface RefreshPayload extends JwtPayload {
  userId: string
  email:  string
  role:   "ADMIN" | "INTERVIEWER" | "CANDIDATE"
}

/* =====================================================
   RATE LIMITING
   Per-IP: max 20 refresh calls per 15 minutes
   This allows normal auto-refresh (every 13min) plus
   a few page reloads without hitting the limit
===================================================== */

const RATE_LIMIT_MAX    = 20
const RATE_LIMIT_WINDOW = 15 * 60 * 1000 // 15 minutes

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

// Clean up old entries every 30 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 30 * 60 * 1000)

function isRateLimited(ip: string): { limited: boolean; retryAfter: number } {
  const now   = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return { limited: false, retryAfter: 0 }
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }
  }

  entry.count++
  return { limited: false, retryAfter: 0 }
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

const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30 // 30 days in seconds

/* =====================================================
   POST /api/auth/refresh
===================================================== */

export async function POST(req: NextRequest) {
  try {

    /* -------------------------
       Rate limit
    -------------------------- */

    const ip = getClientIp(req)
    const { limited, retryAfter } = isRateLimited(ip)

    if (limited) {
      return NextResponse.json(
        { error: "Too many requests. Please wait before refreshing." },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter) },
        }
      )
    }

    /* -------------------------
       Read refresh token from httpOnly cookie
    -------------------------- */

    const refreshToken = req.cookies.get("refreshToken")?.value

    if (!refreshToken) {
      return NextResponse.json(
        { error: "Refresh token missing" },
        { status: 401 }
      )
    }

    /* -------------------------
       Verify JWT signature + expiry
    -------------------------- */

    let decoded: RefreshPayload

    try {
      decoded = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET as string
      ) as RefreshPayload
    } catch {
      return NextResponse.json(
        { error: "Invalid or expired refresh token" },
        { status: 401 }
      )
    }

    /* -------------------------
       Hash token to match stored value
    -------------------------- */

    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex")

    /* -------------------------
       Look up session
    -------------------------- */

    const session = await prisma.session.findUnique({
      where: { token: hashedToken },
    })

    if (!session) {
      return NextResponse.json({ error: "Invalid session" }, { status: 401 })
    }

    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: session.id } })
      return NextResponse.json({ error: "Session expired" }, { status: 401 })
    }

    /* -------------------------
       Get user + check still active
    -------------------------- */

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: {
        id:           true,
        email:        true,
        name:         true,
        role:         true,
        status:       true,
        isActive:     true,
        deletedAt:    true,
        profileImage: true,
        phone:        true,
        emailVerified: true,
      },
    })

    if (!user || user.deletedAt !== null) {
      await prisma.session.delete({ where: { id: session.id } })
      return NextResponse.json({ error: "Account not found" }, { status: 401 })
    }

    if (!user.isActive || user.status === "SUSPENDED") {
      await prisma.session.delete({ where: { id: session.id } })
      return NextResponse.json({ error: "Account inactive or suspended" }, { status: 403 })
    }

    /* -------------------------
       Rotate refresh token
    -------------------------- */

    const newRefreshToken  = generateRefreshToken(user.id)
    const newHashedToken   = crypto.createHash("sha256").update(newRefreshToken).digest("hex")
    const newExpiresAt     = new Date(Date.now() + REFRESH_TOKEN_MAX_AGE * 1000)

    await prisma.$transaction([
      prisma.session.delete({ where: { id: session.id } }),
      prisma.session.create({
        data: {
          token:     newHashedToken,
          userId:    user.id,
          expiresAt: newExpiresAt,
          ipAddress: getClientIp(req),
          userAgent: req.headers.get("user-agent") ?? null,
        },
      }),
    ])

    /* -------------------------
       Generate new access token
    -------------------------- */

    const options: SignOptions = { expiresIn: "15m" }

    const newAccessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      options
    )

    /* -------------------------
       Response
    -------------------------- */

    const response = NextResponse.json({
      success:     true,
      accessToken: newAccessToken,
      user: {
        id:            user.id,
        email:         user.email,
        name:          user.name,
        role:          user.role,
        profileImage:  user.profileImage,
        phone:         user.phone,
        emailVerified: user.emailVerified,
      },
    })

    response.cookies.set("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "strict",
      path:     "/",
      maxAge:   REFRESH_TOKEN_MAX_AGE,
    })

    return response
  } catch (error) {
    console.error("Refresh error:", error instanceof Error ? error.message : error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}