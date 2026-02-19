import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import z from "zod/v4";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { loadQuestionBank } from "@/lib/question-bank";
import {
  capText,
  filterQuestions,
  type InterviewMode,
  interviewModeConfigs,
  pickQuestion,
  settingsSchema,
  sumConversationChars,
} from "@/lib/mock-interview";

/**
 * Combined turn + TTS endpoint.
 *
 * Instead of the client calling /turn then /tts sequentially, this endpoint:
 * 1. Generates the interviewer text (quality model)
 * 2. Fires TTS request in parallel with real-time feedback generation
 * 3. Returns both the text AND the audio as a multipart response
 *
 * This saves one full round-trip latency (typically 300-800ms for TTS).
 */

const LIMIT = 60;
const WINDOW_MS = 10 * 60 * 1000;
const MODEL = "gpt-4o-mini";
const MAX_TURN_CHARS = 4000;
const MAX_HISTORY_CHARS = 8000;

const conversationSchema = z.object({
  role: z.enum(["interviewer", "user"]),
  content: z.string().min(1),
});

const turnSchema = z.object({
  settings: settingsSchema,
  conversation: z.array(conversationSchema).default([]),
  lastQuestionId: z.string().min(1),
  askedQuestionIds: z.array(z.string()).default([]),
  lastUserTurn: z.string().min(1),
  interviewMode: z.string().optional(),
  includeAudio: z.boolean().optional(), // If true, include TTS audio in response
});

function extractOutputText(data: unknown) {
  const payload = data as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  };
  const direct = typeof payload?.output_text === "string" ? payload.output_text.trim() : "";
  if (direct) return direct;
  const outputItems = Array.isArray(payload?.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of outputItems) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("").trim();
}

async function generateTTS(text: string): Promise<ArrayBuffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2";

  if (!apiKey || !voiceId) return null;

  const speakText = text.length > 280 ? text.slice(0, 277) + "..." : text;

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128&optimize_streaming_latency=3`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({ text: speakText, model_id: modelId }),
      }
    );
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID();
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized", requestId }, { status: 401 });
  }
  if (!isAllowedEmail(email)) {
    return NextResponse.json({ error: "Forbidden", requestId }, { status: 403 });
  }

  if (process.env.NODE_ENV === "production") {
    const rate = enforceUserRateLimit({ key: email, limit: LIMIT, windowMs: WINDOW_MS });
    if (!rate.allowed) {
      const retryAfter = Math.ceil(rate.retryAfterMs / 1000);
      return NextResponse.json(
        { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`, requestId, retryAfterSeconds: retryAfter },
        { status: 429, headers: { "Retry-After": retryAfter.toString() } }
      );
    }
  }

  let body: z.infer<typeof turnSchema>;
  try {
    body = turnSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body", requestId }, { status: 400 });
  }

  const { settings, conversation, askedQuestionIds, lastQuestionId, lastUserTurn } = body;
  const mode = (body.interviewMode || "standard") as InterviewMode;
  const modeConfig = interviewModeConfigs[mode] || interviewModeConfigs.standard;

  if (lastUserTurn.length > MAX_TURN_CHARS) {
    return NextResponse.json({ error: "Answer too long", requestId }, { status: 413 });
  }
  if (sumConversationChars(conversation) > MAX_HISTORY_CHARS) {
    return NextResponse.json({ error: "Conversation history too long", requestId }, { status: 413 });
  }

  const questions = loadQuestionBank();
  const currentQuestion = questions.find((q) => q.id === lastQuestionId);
  if (!currentQuestion) {
    return NextResponse.json({ error: "Unknown question id", requestId }, { status: 400 });
  }

  const shouldFollowUp = settings.followUps && lastUserTurn.trim().length < 220 && lastUserTurn.split(" ").length < 50;
  let nextQuestion = null;
  if (!shouldFollowUp) {
    const eligible = filterQuestions(questions, settings, askedQuestionIds);
    nextQuestion = pickQuestion(eligible, settings.randomize);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY", requestId }, { status: 500 });
  }

  const nextLine = shouldFollowUp
    ? `Ask a brief follow-up on: ${currentQuestion.prompt}`
    : `Ask the next question: ${nextQuestion?.prompt || currentQuestion.prompt}`;

  const modeContext = modeConfig.promptContext ? `\n${modeConfig.promptContext}\n` : "";

  const interviewerPrompt = `You are a mock interview interviewer conducting a ${modeConfig.label} interview.
Acknowledge the user's answer briefly, then ask one question.
Keep it concise and speakable (<= 280 characters).
${modeContext}
Last user answer:
${lastUserTurn}

${nextLine}

Settings:
- Firm: ${settings.firm}
- Stage: ${settings.stage}
`;

  // Step 1: Generate interviewer text
  let interviewerText = "";
  try {
    const interviewerResp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: "system", content: `You are a mock interview interviewer conducting a ${modeConfig.label} interview. One question at a time, keep it concise and professional.` },
          { role: "user", content: interviewerPrompt },
        ],
      }),
    });

    if (!interviewerResp.ok) {
      const errorText = await interviewerResp.text();
      return NextResponse.json({ error: errorText || interviewerResp.statusText, requestId }, { status: 502 });
    }

    const data = await interviewerResp.json();
    interviewerText = extractOutputText(data);
  } catch {
    return NextResponse.json({ error: "Upstream request failed", requestId }, { status: 502 });
  }

  if (!interviewerText) {
    return NextResponse.json({ error: "Empty model output", requestId }, { status: 502 });
  }

  const cappedText = capText(interviewerText, 280);

  // Step 2: Fire TTS and feedback generation IN PARALLEL
  const [audioBuffer, realtimeFeedback] = await Promise.all([
    // TTS — runs in parallel
    body.includeAudio ? generateTTS(cappedText) : Promise.resolve(null),

    // Feedback — runs in parallel
    (async () => {
      try {
        const feedbackResp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            input: [
              { role: "system", content: `You are a mock interview coach for a ${modeConfig.label} interview. Keep feedback tight and skimmable.` },
              {
                role: "user",
                content: `Provide concise coaching bullets for the user's last answer in a ${modeConfig.label} mock interview.
Format as 4-5 bullet lines:
- Technical accuracy / content quality
- Structure / clarity
- Depth / specificity
- Better phrasing
- Key improvement area
${modeConfig.gradingFocus ? `\nGrading focus: ${modeConfig.gradingFocus}\n` : ""}
Settings:
- Firm: ${settings.firm}
- Stage: ${settings.stage}

Answer:
${lastUserTurn}`,
              },
            ],
          }),
        });
        if (feedbackResp.ok) {
          const data = await feedbackResp.json();
          return extractOutputText(data);
        }
        return "";
      } catch {
        return "";
      }
    })(),
  ]);

  const done = !nextQuestion && !shouldFollowUp;

  // Build response with optional base64 audio
  const responseBody = {
    interviewerText: cappedText,
    realtimeFeedback,
    nextQuestionId: shouldFollowUp ? currentQuestion.id : nextQuestion?.id || currentQuestion.id,
    done,
    requestId,
    ...(audioBuffer ? { audioBase64: Buffer.from(audioBuffer).toString("base64") } : {}),
  };

  return NextResponse.json(responseBody);
}
