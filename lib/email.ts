import { Resend } from "resend"
import { prisma } from "@/lib/prisma"
import crypto from "crypto"


const resend  = new Resend(process.env.RESEND_API_KEY)
const APP_URL = process.env.NEXT_PUBLIC_APP_URL
const FROM    = process.env.EMAIL_FROM ?? "TrueHire <noreply@yourdomain.com>"

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

/* =====================================================
   SHARED TEMPLATE WRAPPER
===================================================== */

function emailTemplate(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#020617;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">

        <!-- Header -->
        <tr><td style="padding:28px 36px 20px;text-align:center;border-bottom:1px solid #1e293b;">
          <div style="display:inline-flex;align-items:center;gap:10px;">
            <div style="width:32px;height:32px;background:linear-gradient(135deg,#6366f1,#3b82f6);border-radius:8px;display:inline-block;text-align:center;line-height:32px;">
              <span style="color:#fff;font-weight:900;font-size:14px;">T</span>
            </div>
            <span style="color:#fff;font-size:18px;font-weight:700;letter-spacing:-0.5px;">TrueHire</span>
          </div>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 36px;">
          ${content}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:16px 36px;border-top:1px solid #1e293b;text-align:center;">
          <p style="color:#334155;font-size:12px;margin:0;">
            &copy; ${new Date().getFullYear()} TrueHire. All rights reserved.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

/* =====================================================
   SEND VERIFICATION EMAIL
   Creates the DB token + sends the email
   Called from: register route, resend-verification route
===================================================== */

export async function sendVerificationEmail(
  userId: string,
  email: string,
  name: string
): Promise<void> {
  const token     = crypto.randomBytes(32).toString("hex")
  const hashed    = hashToken(token)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

  await prisma.session.create({
    data: {
      token:     `verify:${hashed}`,
      userId,
      expiresAt,
      userAgent: "email-verification",
    },
  })

  const url = `${APP_URL}/api/auth/verify-email?token=${token}&email=${encodeURIComponent(email)}`

  await resend.emails.send({
    from:    FROM,
    to:      email,
    subject: "Verify your TrueHire account",
    html: emailTemplate(`
      <h1 style="color:#fff;font-size:20px;font-weight:600;margin:0 0 10px;">Verify your email</h1>
      <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Hi ${name}, click the button below to verify your email address and activate your TrueHire account.
      </p>
      <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
        Verify email address
      </a>
      <p style="color:#475569;font-size:12px;margin:20px 0 0;line-height:1.5;">
        This link expires in 24 hours. If you did not create a TrueHire account, ignore this email.
      </p>
    `),
  })
}

/* =====================================================
   SEND FORGOT PASSWORD EMAIL
   Called from: forgot-password route
===================================================== */

export async function sendForgotPasswordEmail(
  email: string,
  name: string,
  token: string
): Promise<void> {
  const url = `${APP_URL}/auth/reset-password?token=${token}&email=${encodeURIComponent(email)}`

  await resend.emails.send({
    from:    FROM,
    to:      email,
    subject: "Reset your TrueHire password",
    html: emailTemplate(`
      <h1 style="color:#fff;font-size:20px;font-weight:600;margin:0 0 10px;">Reset your password</h1>
      <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Hi ${name}, we received a request to reset your password. Click below to choose a new one.
      </p>
      <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
        Reset password
      </a>
      <p style="color:#475569;font-size:12px;margin:20px 0 0;line-height:1.5;">
        This link expires in <strong style="color:#94a3b8;">1 hour</strong>.
        If you did not request a password reset, you can safely ignore this email.
      </p>
    `),
  })
}

/* =====================================================
   SEND INTERVIEW REMINDER EMAIL
   Called from: scheduled cron job (future)
===================================================== */

export async function sendInterviewReminderEmail(
  email: string,
  name: string,
  interviewTitle: string,
  interviewId: string,
  startTime: Date
): Promise<void> {
  const url     = `${APP_URL}/interview/${interviewId}/prepare`
  const timeStr = startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  const dateStr = startTime.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })

  await resend.emails.send({
    from:    FROM,
    to:      email,
    subject: `Your interview starts in 30 minutes — ${interviewTitle}`,
    html: emailTemplate(`
      <h1 style="color:#fff;font-size:20px;font-weight:600;margin:0 0 10px;">Interview reminder</h1>
      <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 20px;">
        Hi ${name}, your interview <strong style="color:#e2e8f0;">${interviewTitle}</strong>
        starts at <strong style="color:#e2e8f0;">${timeStr}</strong> on ${dateStr}.
      </p>
      <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;margin:0 0 24px;">
        <p style="color:#94a3b8;font-size:13px;margin:0 0 6px;">Before you start:</p>
        <ul style="color:#cbd5e1;font-size:13px;line-height:1.8;margin:0;padding-left:18px;">
          <li>Test your camera and microphone</li>
          <li>Close all unnecessary tabs</li>
          <li>Find a quiet place</li>
          <li>Have a stable internet connection</li>
        </ul>
      </div>
      <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:600;">
        Go to prepare page
      </a>
    `),
  })
}