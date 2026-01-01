import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";

const MAX_TEXT_CHARS = 800;
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 30;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAllowedEmail(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rate = enforceUserRateLimit({ key: email, limit: LIMIT, windowMs: WINDOW_MS });
  if (!rate.allowed) {
    const retryAfter = Math.ceil(rate.retryAfterMs / 1000);
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${retryAfter} seconds.` },
      {
        status: 429,
        headers: { "Retry-After": retryAfter.toString() },
      }
    );
  }

  let body: { text?: string; voiceId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const text = (body.text || "").trim();
  if (!text) {
    return NextResponse.json({ error: "Text is required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json({ error: "Text too long (max 800 chars)" }, { status: 413 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY" }, { status: 500 });
  }

  const voiceId = body.voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    return NextResponse.json({ error: "Missing ELEVENLABS_VOICE_ID" }, { status: 500 });
  }

  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_monolingual_v1";

  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      return NextResponse.json({ error: errorText || "TTS failed" }, { status: 500 });
    }

    const contentType = resp.headers.get("content-type") || "audio/mpeg";
    const audioBuffer = await resp.arrayBuffer();
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  } catch {
    return NextResponse.json({ error: "TTS request failed" }, { status: 500 });
  }
}
