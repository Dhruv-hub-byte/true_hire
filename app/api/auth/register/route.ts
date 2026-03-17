import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import crypto from "crypto"

import { prisma } from "@/lib/prisma"
import {
  hashPassword,
  validatePasswordStrength,
  generateToken,
  generateRefreshToken,
} from "@/lib/auth"

import { sendVerificationEmail } from "@/lib/email"

/* =====================================================
   ENV GUARD
===================================================== */


/* =====================================================
   RATE LIMITING (in-memory — swap for Upstash in prod)
===================================================== */

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const RATE_LIMIT_MAX = 5

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

const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30 // 30 days in seconds

/* =====================================================
   VALIDATION
===================================================== */

const registerSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(2, "Name must be at least 2 characters").max(100, "Name too long"),
  role: z.enum(["ADMIN", "INTERVIEWER", "CANDIDATE"]).default("CANDIDATE"),
})

/* =====================================================
   ROUTE
===================================================== */

export async function POST(req: NextRequest) {
  try {
    /* -------------------------
       Rate limiting
    -------------------------- */

    const ip = getClientIp(req)

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many registration attempts. Please try again later." },
        { status: 429 }
      )
    }

    /* -------------------------
       Validate input
    -------------------------- */

    const body = await req.json()
    const parsed = registerSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      )
    }

    const { email, password, name, role } = parsed.data

    /* -------------------------
       Password strength check
    -------------------------- */

    const strength = validatePasswordStrength(password)

    if (!strength.isStrong) {
      return NextResponse.json(
        { error: "Weak password", details: strength.errors },
        { status: 400 }
      )
    }

    /* -------------------------
       Duplicate email check
    -------------------------- */

    const exists = await prisma.user.findUnique({ where: { email } })

    // Block if active account exists with this email
    // Allow re-registration if previous account was soft-deleted
    if (exists && exists.deletedAt === null) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 409 }
      )
    }

    /* -------------------------
       Hash password
    -------------------------- */

    const hashed = await hashPassword(password)

    /* -------------------------
       Create user
       Note: id is @default(cuid()) in schema — Prisma handles it
    -------------------------- */

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        name,
        role: role as "ADMIN" | "INTERVIEWER" | "CANDIDATE",
        emailVerified: false, // must verify via email link
        isActive: true,
      },
    })

    /* -------------------------
       Generate tokens + create session
    -------------------------- */

    const refreshToken = generateRefreshToken(user.id)

    const hashedToken = crypto
      .createHash("sha256")
      .update(refreshToken)
      .digest("hex")

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_MAX_AGE * 1000)

    await prisma.session.create({
      data: {
        token: hashedToken,
        userId: user.id,
        expiresAt,
        ipAddress: getClientIp(req),
        userAgent: req.headers.get("user-agent") ?? null,
      },
    })

    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role as "ADMIN" | "INTERVIEWER" | "CANDIDATE",
    }

    const accessToken = generateToken(payload)

    /* -------------------------
       Send verification email (fire and forget)
    -------------------------- */

    sendVerificationEmail(user.id, user.email, user.name).catch((err) => {
      console.error("Failed to send verification email:", err instanceof Error ? err.message : err)
    })

    /* -------------------------
       Response — refresh token in httpOnly cookie only
    -------------------------- */

    const response = NextResponse.json(
      {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
        tokens: { accessToken },
      },
      { status: 201 }
    )

    response.cookies.set("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: REFRESH_TOKEN_MAX_AGE,
    })

    return response
  } catch (err) {
    console.error("Register error:", err instanceof Error ? err.message : err)

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}