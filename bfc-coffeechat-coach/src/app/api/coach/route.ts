import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/auth";

type CoachScenario = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  userGoal: string;
};

type CoachRequest = {
  transcript?: string;
  scenario?: CoachScenario;
};

function buildPrompt(transcript: string, scenario: CoachScenario) {
  return `You are a coffee chat coach helping the user earn a referral. Provide concise, actionable feedback in markdown.\n\nScenario:\n- Track: ${scenario.track}\n- Firm type: ${scenario.firmType}\n- Group: ${scenario.group}\n- Interviewer vibe: ${scenario.interviewerVibe}\n- User goal: ${scenario.userGoal}\n\nTranscript:\n${transcript}`;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  }

  let body: CoachRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const transcript = (body.transcript || "").trim();
  const scenario = body.scenario;

  if (!transcript || !scenario) {
    return NextResponse.json({ error: "Missing transcript or scenario" }, { status: 400 });
  }

  const prompt = buildPrompt(transcript, scenario);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5",
      reasoning: { effort: "low" },
      input: [
        {
          role: "system",
          content:
            "You are a coffee chat coach. Output must be markdown. Follow this rubric: 1) What they did well (2 bullets). 2) What hurt rapport (tone, interruptions, entitlement). 3) Question quality (too generic? too long? too early for referral ask?). 4) A better next question (1-2 examples). 5) A clean referral ask line tailored to the scenario.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return NextResponse.json(
      { error: errorText || response.statusText },
      { status: response.status }
    );
  }

  const data = await response.json();
  const outputText =
    data?.output?.[0]?.content?.find((item: { type: string; text?: string }) => item.type === "output_text")
      ?.text || "";

  if (!outputText) {
    return NextResponse.json({ error: "No feedback returned" }, { status: 502 });
  }

  return NextResponse.json({ feedback: outputText.trim() });
}
