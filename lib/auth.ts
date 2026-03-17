import jwt, { SignOptions, JwtPayload } from "jsonwebtoken"
import bcrypt from "bcryptjs"
import crypto from "crypto"

/* =====================================================
   ENV GUARD
===================================================== */

function getJwtSecret() { return process.env.JWT_SECRET ?? "" }
function getJwtRefreshSecret() { return process.env.JWT_REFRESH_SECRET ?? "" }

// Access token should be short-lived — 15 minutes default
// Refresh token handles longevity
const JWT_EXPIRY = (process.env.JWT_EXPIRY || "15m") as SignOptions["expiresIn"]
const JWT_REFRESH_EXPIRY = (process.env.JWT_REFRESH_EXPIRY || "30d") as SignOptions["expiresIn"]

/* =====================================================
   TYPES
===================================================== */

export interface JWTPayload {
  userId: string
  email: string
  role: "ADMIN" | "INTERVIEWER" | "CANDIDATE"
}

/* =====================================================
   ACCESS TOKEN
===================================================== */

export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: JWT_EXPIRY,
    algorithm: "HS256",
  })
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ["HS256"],
    }) as JwtPayload & JWTPayload

    // Ensure required fields are present
    if (!decoded.userId || !decoded.email || !decoded.role) return null

    return {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    }
  } catch {
    // Don't log — verification failures are expected for expired/invalid tokens
    return null
  }
}

/* =====================================================
   REFRESH TOKEN
===================================================== */

export function generateRefreshToken(userId: string): string {
  return jwt.sign({ userId }, getJwtRefreshSecret(), {
    expiresIn: JWT_REFRESH_EXPIRY,
    algorithm: "HS256",
  })
}

export function verifyRefreshToken(token: string): { userId: string } | null {
  try {
    const decoded = jwt.verify(token, getJwtRefreshSecret(), {
      algorithms: ["HS256"],
    }) as JwtPayload & { userId: string }

    if (!decoded.userId) return null

    return { userId: decoded.userId }
  } catch {
    return null
  }
}

/* =====================================================
   PASSWORD
===================================================== */

const BCRYPT_ROUNDS = 12 // 10 is minimum acceptable; 12 is recommended for 2024+

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/* =====================================================
   TOKEN EXTRACTION
===================================================== */

export function extractTokenFromHeader(header?: string | null): string | null {
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice(7).trim()
  return token.length > 0 ? token : null
}

/* =====================================================
   OTP
   Uses crypto.randomInt for cryptographically secure generation
   Math.random() is NOT suitable for security-sensitive codes
===================================================== */

export function generateOTP(): string {
  // Generates a 6-digit code between 100000 and 999999 (inclusive)
  return crypto.randomInt(100000, 1000000).toString()
}

/* =====================================================
   VALIDATION HELPERS
===================================================== */

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function validatePasswordStrength(password: string): {
  isStrong: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (password.length < 8)          errors.push("Minimum 8 characters")
  if (!/[A-Z]/.test(password))      errors.push("One uppercase letter required")
  if (!/[a-z]/.test(password))      errors.push("One lowercase letter required")
  if (!/[0-9]/.test(password))      errors.push("One number required")
  if (!/[!@#$%^&*]/.test(password)) errors.push("One special character required (!@#$%^&*)")

  return {
    isStrong: errors.length === 0,
    errors,
  }
}