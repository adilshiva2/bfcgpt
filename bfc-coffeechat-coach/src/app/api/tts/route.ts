import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceUserRateLimit } from "@/lib/rate-limit";

const MAX_TEXT_CHARS = 800;
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 60;

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
        {
          error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          requestId,
          retryAfterSeconds: retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": retryAfter.toString() },
        }
      );
    }
  }

  let body: { text?: string; voiceId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON", requestId }, { status: 400 });
  }

  const text = (body.text || "").trim();
  if (!text) {
    return NextResponse.json({ error: "Text is required", requestId }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: "Text too long (max 800 chars)", requestId },
      { status: 413 }
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ELEVENLABS_API_KEY", requestId }, { status: 500 });
  }

  const voiceId = body.voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) {
    return NextResponse.json({ error: "Missing ELEVENLABS_VOICE_ID", requestId }, { status: 500 });
  }

  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2";

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128&optimize_streaming_latency=3`,
      {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
      }),
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      return NextResponse.json(
        { error: (errorText || "TTS failed").slice(0, 300), requestId },
        { status: 502 }
      );
    }

    const contentType = resp.headers.get("content-type") || "audio/mpeg";
    // Stream the ElevenLabs response directly instead of buffering — reduces
    // time-to-first-byte on the client so audio can begin loading sooner.
    return new NextResponse(resp.body, {
      status: 200,
      headers: { "Content-Type": contentType },
    });
  } catch {
    return NextResponse.json({ error: "TTS request failed", requestId }, { status: 500 });
  }
}
