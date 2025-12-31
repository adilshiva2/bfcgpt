import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";
import { isAllowedEmail } from "@/lib/auth-allowlist";
import { enforceRateLimit } from "@/lib/rate-limit";

function getClientIp(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return req.headers.get("x-real-ip") || "unknown";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAllowedEmail(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rate = enforceRateLimit({ userKey: email, ipKey: getClientIp(req) });
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  }

  const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1",
    },
    body: JSON.stringify({
      session: { type: "realtime", model: "gpt-realtime", voice: "marin" },
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    return NextResponse.json(
      { error: errorText || resp.statusText },
      { status: resp.status }
    );
  }

  const data = await resp.json();
  const value = data?.value ?? data?.client_secret?.value;
  if (!value) {
    return NextResponse.json({ error: "Unexpected realtime token response." }, { status: 502 });
  }
  return NextResponse.json({ value });
}
