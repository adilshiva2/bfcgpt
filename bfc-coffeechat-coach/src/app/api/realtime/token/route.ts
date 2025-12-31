import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
