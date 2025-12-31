"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  tool,
} from "@openai/agents/realtime";

import {
  CoachingStyle,
  generateScenario,
  buildInstructions,
  RoleTrack,
  Scenario,
} from "@/lib/networking-scenarios";

type FeedbackItem = {
  id: number;
  timeLabel: string;
  overallScore: number; // 0-100
  stage: "opening" | "story" | "fit" | "questions" | "closing" | "followup" | "general";
  items: Array<{
    category: "tone" | "structure" | "content" | "rapport" | "referral";
    severity: 1 | 2 | 3 | 4 | 5;
    quote?: string;
    issue: string;
    better: string;
  }>;
  nextMove: string;
};

const TOKEN_ENDPOINT = "/api/realtime/token"; // <-- if your endpoint is different, change this.

const roleTracks: RoleTrack[] = [
  "Investment Banking",
  "Private Equity",
  "Equity Research",
  "Sales & Trading",
  "Venture Capital",
  "Corporate Development",
];

const coachingStyles: CoachingStyle[] = ["Gentle", "Balanced", "Tough"];

const feedbackSchema = z.object({
  overallScore: z.number().min(0).max(100),
  stage: z.enum(["opening", "story", "fit", "questions", "closing", "followup", "general"]),
  items: z
    .array(
      z.object({
        category: z.enum(["tone", "structure", "content", "rapport", "referral"]),
        severity: z.number().min(1).max(5),
        quote: z.string().nullable(),
        issue: z.string(),
        better: z.string(),
      })
    )
    .min(1)
    .max(4),
  nextMove: z.string(),
});

export default function PracticeClient() {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const transportRef = useRef<OpenAIRealtimeWebRTC | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const feedbackIdRef = useRef(0);

  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [track, setTrack] = useState<RoleTrack>("Investment Banking");
  const [coachingStyle, setCoachingStyle] = useState<CoachingStyle>("Balanced");
  const [voiceDebrief, setVoiceDebrief] = useState(true);

  const DEFAULT_SCENARIO: Scenario = {
    track: "Investment Banking",
    firmType: "Bulge Bracket",
    group: "TMT",
    person: { title: "Analyst", yearsExp: 1, vibe: "neutral" },
    twist: "They have limited time and dislike generic questions.",
    userGoal: "referral",
  };

  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const debugRealtime = process.env.NEXT_PUBLIC_DEBUG_REALTIME === "true";

  useEffect(() => {
    if (debugRealtime) {
      console.log("[realtime] connected:", connected);
    }
  }, [connected, debugRealtime]);

  const panelFeedbackTool = useMemo(() => {
    return tool({
      name: "panel_feedback",
      description:
        "Send coaching feedback to the UI panel. This must be used after every candidate answer.",
      parameters: feedbackSchema,
      async execute(args) {
        const parsed = feedbackSchema.parse(args);
        const id = feedbackIdRef.current++;

        const item: FeedbackItem = {
          id,
          timeLabel: new Date().toLocaleTimeString(),
          overallScore: parsed.overallScore,
          stage: parsed.stage,
          items: parsed.items.map((x) => ({
            category: x.category,
            severity: x.severity as 1 | 2 | 3 | 4 | 5,
            quote: x.quote ?? undefined,
            issue: x.issue,
            better: x.better,
          })),
          nextMove: parsed.nextMove,
        };

        setFeedback((prev) => [item, ...prev].slice(0, 50));
        setLastScore(parsed.overallScore);

        return "ok";
      },
    });
  }, []);

  const makeAgent = useCallback(
    (sc: Scenario) => {
      const instructions = buildInstructions({
        scenario: sc,
        coachingStyle,
        voiceDebrief,
      });

      return new RealtimeAgent({
        name: "CoffeeChatCoach",
        instructions,
        voice: "marin",
        tools: [panelFeedbackTool],
      });
    },
    [coachingStyle, voiceDebrief, panelFeedbackTool]
  );

  const start = useCallback(async () => {
    if (starting || connected) return;

    setStarting(true);
    setStartError(null);
    setFeedback([]);
    setLastScore(null);
    feedbackIdRef.current = 0;

    const newScenario = generateScenario(track);
    setScenario(newScenario);

    try {
      // 1) Create (or reuse) a mic stream so the browser prompts immediately
      if (!mediaStreamRef.current) {
        mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      // 2) Fetch ephemeral client key from your server endpoint
      const tokenRes = await fetch(TOKEN_ENDPOINT);
      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        throw new Error(
          `Token endpoint failed (${tokenRes.status}): ${errorText || tokenRes.statusText}`
        );
      }
      // Expecting { value: "ek_..." } (common pattern)
      const tokenJson = await tokenRes.json();
      const ephemeralKey = tokenJson?.value || tokenJson?.apiKey || tokenJson?.token;
      if (!ephemeralKey) {
        throw new Error("Could not find ephemeral key in token response. Check /api/realtime/token.");
      }

      // 3) Ensure a DOM audio element for reliable playback
      if (!audioElementRef.current) {
        const audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioEl.volume = 1;
        audioEl.setAttribute("playsinline", "");
        audioEl.style.display = "none";
        audioEl.addEventListener("loadedmetadata", () => {
          audioEl.play().catch(() => undefined);
        });
        document.body.appendChild(audioEl);
        audioElementRef.current = audioEl;
      }

      const audioEl = audioElementRef.current;
      if (!audioEl) {
        throw new Error("Audio element not initialized.");
      }

      const transport = new OpenAIRealtimeWebRTC({
        mediaStream: mediaStreamRef.current,
        audioElement: audioEl,
      });

      transportRef.current = transport;

      // 4) Create agent + session
      const agent = makeAgent(newScenario);

      const session = new RealtimeSession(agent, {
        transport,
        model: "gpt-realtime",
        config: {
          turnDetection: {
            type: "semantic_vad",
            eagerness: "medium",
            createResponse: true,
            interruptResponse: true,
          },
        },
      });

      sessionRef.current = session;

      // Useful lifecycle events
      transport.on("connected", () => {
        if (debugRealtime) {
          console.log("[realtime] transport connected");
        }
        setConnected(true);
        audioEl.play().catch(() => undefined);
      });
      transport.on("disconnected", () => {
        if (debugRealtime) {
          console.log("[realtime] transport disconnected");
        }
        setConnected(false);
      });

      // 5) Connect
      await session.connect({ apiKey: ephemeralKey });
      await audioEl.play().catch(() => undefined);

      // Optional: initial “kick off”
      try {
        await session.sendMessage(
          "Start the coffee chat now. Begin with a realistic greeting and 1 opening question."
        );
        if (debugRealtime) {
          console.log("[realtime] kickoff message sent");
        }
      } catch (err) {
        if (debugRealtime) {
          console.error("[realtime] kickoff message failed", err);
        }
      }
    } catch (e) {
      console.error(e);
      setStartError(e instanceof Error ? e.message : "Unable to start call.");
      setConnected(false);
    } finally {
      setStarting(false);
    }
  }, [starting, connected, track, makeAgent, debugRealtime]);

  const stop = useCallback(() => {
    try {
      sessionRef.current?.close(); // RealtimeSession has close() :contentReference[oaicite:1]{index=1}
      transportRef.current?.close();
    } catch (e) {
      console.error(e);
    } finally {
      sessionRef.current = null;
      transportRef.current = null;
      setConnected(false);
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((trackItem) => trackItem.stop());
        mediaStreamRef.current = null;
      }
      if (audioElementRef.current) {
        audioElementRef.current.srcObject = null;
        audioElementRef.current.remove();
        audioElementRef.current = null;
      }
    }
  }, []);

  const coachNow = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    await s.sendMessage(
      "Coach now: give a 20–25 second spoken debrief focused on the single biggest improvement to increase referral probability, then return to the chat."
    );
  }, []);

  const testAudio = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      await s.sendMessage('Say out loud: "Audio test: I can hear you."');
      if (debugRealtime) {
        console.log("[realtime] test audio sent");
      }
    } catch (err) {
      console.error("[realtime] test audio failed", err);
    }
  }, [debugRealtime]);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(track);
    setScenario(sc);
  }, [track]);

  return (
    <div className="flex h-[calc(100vh-6rem)] w-full gap-4">
      {/* Left: controls + main */}
      <div className="flex flex-1 flex-col gap-4">
        <div className="rounded-xl border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Track</label>
              <select
                className="rounded-md border px-3 py-2"
                value={track}
                onChange={(e) => setTrack(e.target.value as RoleTrack)}
                disabled={starting || connected}
              >
                {roleTracks.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Coaching style</label>
              <select
                className="rounded-md border px-3 py-2"
                value={coachingStyle}
                onChange={(e) => setCoachingStyle(e.target.value as CoachingStyle)}
                disabled={starting || connected}
              >
                {coachingStyles.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 pb-2">
              <input
                type="checkbox"
                checked={voiceDebrief}
                onChange={(e) => setVoiceDebrief(e.target.checked)}
                disabled={starting || connected}
              />
              <span className="text-sm">Voice debrief after each answer</span>
            </label>

            <button
              className="rounded-md border px-4 py-2"
              onClick={rerollScenarioOnly}
              disabled={starting || connected}
              title="Preview a scenario before starting"
            >
              Randomize scenario
            </button>

            {!connected ? (
              <button
                className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
                onClick={start}
                disabled={starting}
              >
                {starting ? "Starting..." : "Start call"}
              </button>
            ) : (
              <>
                <button className="rounded-md border px-4 py-2" onClick={coachNow}>
                  Coach now
                </button>
                <button className="rounded-md border px-4 py-2" onClick={testAudio}>
                  Test audio
                </button>
                <button className="rounded-md bg-red-600 px-4 py-2 text-white" onClick={stop}>
                  End call
                </button>
              </>
            )}

            <div className="ml-auto text-sm">
              Status:{" "}
              <span className={connected ? "font-semibold text-green-600" : "font-semibold"}>
                {connected ? "Connected" : "Not connected"}
              </span>
              {lastScore !== null ? (
                <span className="ml-3">
                  Score: <span className="font-semibold">{lastScore}</span>
                </span>
              ) : null}
            </div>
          </div>
          {startError ? (
            <div className="mt-3 text-sm text-red-600">{startError}</div>
          ) : null}

          {/* Scenario preview */}
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-900">
            <div className="font-semibold">Scenario</div>
            <div className="mt-1 text-slate-900">
              <span className="font-medium">{scenario.person.title}</span> ({scenario.person.yearsExp}{" "}
              yrs) • {scenario.firmType} • {scenario.group} •{" "}
              <span className="text-slate-600">vibe:</span>{" "}
              <span className="font-medium text-slate-900">{scenario.person.vibe}</span>
            </div>
            <div className="mt-1 text-slate-900">{scenario.twist}</div>
            <div className="mt-1 text-slate-900">
              <span className="text-slate-600">Goal:</span>{" "}
              <span className="font-semibold text-slate-900">Referral</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border p-4">
          <div className="text-sm text-gray-700">
            Talk normally. The agent will run the coffee chat. Coaching appears on the right panel.
            {voiceDebrief ? " You’ll also hear short debriefs after your answers." : " Debriefs stay silent."}
          </div>
        </div>
      </div>

      {/* Right: feedback panel */}
      <div className="w-[420px] shrink-0 rounded-xl border p-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold">Live coaching panel</div>
          <div className="text-xs text-gray-500">{feedback.length}/50</div>
        </div>

        {feedback.length === 0 ? (
          <div className="mt-4 text-sm text-gray-600">
            No feedback yet. Start a call and answer a question to see coaching here.
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {feedback.map((f) => (
              <div key={f.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    Score {f.overallScore} • {f.stage}
                  </div>
                  <div className="text-xs text-gray-500">{f.timeLabel}</div>
                </div>

                <div className="mt-2 flex flex-col gap-2">
                  {f.items.map((it, j) => (
                    <div key={j} className="text-sm">
                      <div className="font-medium">
                        {it.category} • severity {it.severity}
                      </div>
                      {it.quote ? (
                        <div className="mt-1 rounded bg-gray-50 p-2 text-xs text-gray-700">
                          “{it.quote}”
                        </div>
                      ) : null}
                      <div className="mt-1 text-gray-800">{it.issue}</div>
                      <div className="mt-1 text-gray-700">
                        <span className="font-medium">Better:</span> {it.better}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 text-sm">
                  <span className="font-medium">Next move:</span> {f.nextMove}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
