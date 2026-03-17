import { GoogleGenerativeAI } from "@google/generative-ai"
import { prisma } from "@/lib/prisma"

/* =====================================================
   ENV GUARD
===================================================== */


/* =====================================================
   GEMINI CLIENT
===================================================== */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// gemini-1.5-flash is free tier — fast and capable
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

/* =====================================================
   TYPES
===================================================== */

interface GenerateReportInput {
  interviewId:    string
  interviewTitle: string
  duration:       number
  questions: {
    text:   string
    type:   string
    answer: string | null
  }[]
  violations: {
    type:        string
    description: string
    severity:    number
  }[]
}

interface ReportOutput {
  summary:             string
  strengths:           string[]
  weaknesses:          string[]
  recommendations:     string[]
  overallScore:        number // 0-100
  sentimentScore:      number // 0-1
  confidenceScore:     number // 0-1
  communicationScore:  number // 0-1
}

/* =====================================================
   GENERATE REPORT
===================================================== */

export async function generateInterviewReport(
  input: GenerateReportInput
): Promise<ReportOutput> {
  const { interviewTitle, questions, violations, duration } = input

  /* -------------------------
     Build prompt
  -------------------------- */

  const questionsText = questions
    .map((q, i) => {
      const answer = q.answer?.trim() || "(No answer provided)"
      return `Question ${i + 1} [${q.type}]: ${q.text}\nAnswer: ${answer}`
    })
    .join("\n\n")

  const violationsText =
    violations.length === 0
      ? "No violations detected."
      : violations
          .map((v) => `- ${v.type} (severity ${v.severity}/5): ${v.description}`)
          .join("\n")

  const prompt = `You are an expert technical interviewer and HR evaluator.
Analyse the following interview and generate a structured evaluation report.

Interview: ${interviewTitle}
Duration: ${duration} minutes

QUESTIONS AND ANSWERS:
${questionsText}

ANTI-CHEAT VIOLATIONS:
${violationsText}

Respond with ONLY a raw JSON object — no markdown, no code fences, no explanation. Just the JSON:
{
  "summary": "2-3 sentence overall assessment",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "recommendations": ["recommendation 1", "recommendation 2"],
  "overallScore": 75,
  "sentimentScore": 0.7,
  "confidenceScore": 0.65,
  "communicationScore": 0.8
}

Rules:
- overallScore: integer 0-100 based on answer quality. Reduce if violations exist.
- sentimentScore: 0.0-1.0 (positive attitude)
- confidenceScore: 0.0-1.0 (certainty and clarity)
- communicationScore: 0.0-1.0 (how clearly ideas were expressed)
- strengths: 2-4 specific positives
- weaknesses: 1-3 areas for improvement
- recommendations: 1-3 actionable suggestions
- Be honest but constructive`

  /* -------------------------
     Call Gemini
  -------------------------- */

  const result = await model.generateContent(prompt)
  const text   = result.response.text()

  // Strip markdown fences if Gemini adds them anyway
  const clean = text.replace(/```json|```/g, "").trim()

  /* -------------------------
     Parse JSON response
  -------------------------- */

  let parsed: ReportOutput

  try {
    parsed = JSON.parse(clean) as ReportOutput
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${clean.slice(0, 200)}`)
  }

  // Clamp values to safe ranges
  parsed.overallScore       = Math.round(Math.min(Math.max(parsed.overallScore ?? 50, 0), 100))
  parsed.sentimentScore     = Math.min(Math.max(parsed.sentimentScore ?? 0.5, 0), 1)
  parsed.confidenceScore    = Math.min(Math.max(parsed.confidenceScore ?? 0.5, 0), 1)
  parsed.communicationScore = Math.min(Math.max(parsed.communicationScore ?? 0.5, 0), 1)

  // Ensure arrays are always arrays
  parsed.strengths       = Array.isArray(parsed.strengths)       ? parsed.strengths       : []
  parsed.weaknesses      = Array.isArray(parsed.weaknesses)      ? parsed.weaknesses      : []
  parsed.recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : []

  return parsed
}

/* =====================================================
   GENERATE AND SAVE REPORT
   Called after interview submit — fetches all data,
   calls Gemini, saves result to DB
===================================================== */

export async function generateAndSaveReport(interviewId: string): Promise<void> {

  /* -------------------------
     Fetch interview data
  -------------------------- */

  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: {
      id:       true,
      title:    true,
      duration: true,
      report:   { select: { id: true } },
      interviewquestion: {
        select: {
          answer: true,
          question: { select: { text: true, type: true } },
        },
        orderBy: { order: "asc" },
      },
      violation: {
        select: { type: true, description: true, severity: true },
      },
    },
  })

  if (!interview) {
    throw new Error(`Interview ${interviewId} not found`)
  }

  // Skip if report already exists
  if (interview.report) {
    console.log(`[AI Report] Already exists for ${interviewId} — skipping`)
    return
  }

  /* -------------------------
     Generate via Gemini
  -------------------------- */

  console.log(`[AI Report] Generating for interview ${interviewId}...`)

  const result = await generateInterviewReport({
    interviewId,
    interviewTitle: interview.title,
    duration:       interview.duration,
    questions: interview.interviewquestion.map((iq) => ({
      text:   iq.question.text,
      type:   iq.question.type,
      answer: iq.answer,
    })),
    violations: interview.violation.map((v) => ({
      type:        v.type,
      description: v.description,
      severity:    v.severity,
    })),
  })

  /* -------------------------
     Save report + scores atomically
  -------------------------- */

  await prisma.$transaction([
    prisma.report.create({
      data: {
        interviewId,
        summary:         result.summary,
        strengths:       result.strengths,
        weaknesses:      result.weaknesses,
        recommendations: result.recommendations,
        overallScore:    result.overallScore,
      },
    }),
    prisma.interview.update({
      where: { id: interviewId },
      data: {
        sentimentScore:     result.sentimentScore,
        confidenceScore:    result.confidenceScore,
        communicationScore: result.communicationScore,
      },
    }),
  ])

  console.log(`[AI Report] Saved for ${interviewId} — score: ${result.overallScore}/100`)
}