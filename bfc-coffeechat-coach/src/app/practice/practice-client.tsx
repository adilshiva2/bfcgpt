"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  firmTypesByTrack,
  generateScenario,
  groupsByTrack,
  RoleTrack,
  Scenario,
  vibes,
} from "@/lib/networking-scenarios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

type CoachScenario = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  userGoal: "referral";
};

const roleTracks: RoleTrack[] = [
  "Investment Banking",
  "Private Equity",
  "Equity Research",
  "Sales & Trading",
  "Venture Capital",
  "Corporate Development",
];

const DEFAULT_SCENARIO: Scenario = {
  track: "Investment Banking",
  firmType: "Bulge Bracket",
  group: "TMT",
  person: { title: "Analyst", yearsExp: 1, vibe: "neutral" },
  twist: "They have limited time and dislike generic questions.",
  userGoal: "referral",
};

function getSpeechRecognition(): SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionImpl) return null;
  return new SpeechRecognitionImpl();
}

export default function PracticeClient() {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);

  const [speechSupported, setSpeechSupported] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState<string>("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [fetchingFeedback, setFetchingFeedback] = useState(false);

  const firmTypeOptions = useMemo(
    () => firmTypesByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const groupOptions = useMemo(
    () => groupsByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const vibeOptions = useMemo(
    () => vibes.map((value) => ({ value, label: value })),
    []
  );

  useEffect(() => {
    setSpeechSupported(
      typeof window !== "undefined" &&
        ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  const startListening = useCallback(() => {
    setSpeechError(null);
    setFeedbackError(null);

    if (!speechSupported) {
      setSpeechError("Speech recognition not supported—use Chrome or enable fallback");
      return;
    }

    if (isListening) return;

    const recognition = getSpeechRecognition();
    if (!recognition) {
      setSpeechError("Speech recognition not supported—use Chrome or enable fallback");
      return;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const chunk = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalText += chunk;
        } else {
          interimText += chunk;
        }
      }

      const trimmedFinal = finalText.trim();
      if (trimmedFinal) {
        setTranscript((prev) => [prev, trimmedFinal].filter(Boolean).join(" "));
      }
      setInterimTranscript(interimText.trim());
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setSpeechError("Microphone permission denied. Allow access and try again.");
      } else {
        setSpeechError(`Speech recognition error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
      setInterimTranscript("");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening, speechSupported]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
    setInterimTranscript("");
  }, []);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(scenario.track);
    setScenario(sc);
  }, [scenario.track]);

  const getFeedback = useCallback(async () => {
    const trimmedTranscript = transcript.trim();
    if (!trimmedTranscript || fetchingFeedback) return;

    setFetchingFeedback(true);
    setFeedback("");
    setFeedbackError(null);

    const scenarioPayload: CoachScenario = {
      track: scenario.track,
      firmType: scenario.firmType,
      group: scenario.group,
      interviewerVibe: scenario.person.vibe,
      userGoal: "referral",
    };

    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: trimmedTranscript, scenario: scenarioPayload }),
      });

      const text = await res.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }

      if (!res.ok) {
        const errorMessage =
          (payload.error as string) ||
          (text && text.length < 240 ? text : "") ||
          res.statusText;
        const requestId = payload.requestId as string | undefined;
        let friendly = errorMessage || "Unable to get feedback.";
        if (res.status === 401) friendly = "Please sign in to get feedback.";
        if (res.status === 402) friendly = "Billing issue. Try again later or contact support.";
        if (res.status === 429) friendly = errorMessage || "Rate limit exceeded. Try again shortly.";
        if (res.status === 413) friendly = errorMessage || "Transcript too long. Shorten your response.";
        if (requestId) {
          friendly = `${friendly} (Request ID: ${requestId})`;
        }
        throw new Error(friendly);
      }

      const feedbackText = typeof payload.feedback === "string" ? payload.feedback : "";
      if (!feedbackText) {
        const debugKeys =
          process.env.NEXT_PUBLIC_DEBUG_COACH === "true"
            ? ` Debug keys: ${Object.keys(payload).join(", ") || "none"}.`
            : "";
        setFeedback(`Empty feedback returned.${debugKeys}`);
        return;
      }
      setFeedback(feedbackText);
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to fetch feedback.");
    } finally {
      setFetchingFeedback(false);
    }
  }, [fetchingFeedback, scenario, transcript]);

  const statusLabel = fetchingFeedback ? "Generating..." : isListening ? "Listening..." : "Ready";
  const statusTone = fetchingFeedback ? "warning" : isListening ? "success" : "neutral";
  const nextBestQuestion = useMemo(() => {
    if (!feedback || feedback.startsWith("No feedback returned")) {
      return "Review feedback to get your next best question.";
    }
    const match = feedback.match(/next best question[:\-]\s*(.*)/i);
    return match?.[1]?.trim() || "Ask for role-specific advice tied to the team’s priorities.";
  }, [feedback]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-10">
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="flex flex-col gap-6">
          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Scenario Builder
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-900">
                  Configure your next coffee chat
                </div>
              </div>
              <Button variant="secondary" onClick={rerollScenarioOnly} type="button">
                Randomize
              </Button>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Select
                label="Track"
                value={scenario.track}
                options={roleTracks.map((value) => ({ value, label: value }))}
                onChange={(value) => {
                  const nextTrack = value as RoleTrack;
                  const nextFirmType = firmTypesByTrack[nextTrack][0];
                  const nextGroup = groupsByTrack[nextTrack][0];
                  setScenario((prev) => ({
                    ...prev,
                    track: nextTrack,
                    firmType: nextFirmType ?? prev.firmType,
                    group: nextGroup ?? prev.group,
                  }));
                }}
              />
              <Select
                label="Firm type"
                value={scenario.firmType}
                options={firmTypeOptions}
                onChange={(value) => setScenario((prev) => ({ ...prev, firmType: value }))}
              />
              <Select
                label="Group"
                value={scenario.group}
                options={groupOptions}
                onChange={(value) => setScenario((prev) => ({ ...prev, group: value }))}
              />
              <Select
                label="Interviewer vibe"
                value={scenario.person.vibe}
                options={vibeOptions}
                onChange={(value) =>
                  setScenario((prev) => ({
                    ...prev,
                    person: { ...prev.person, vibe: value as Scenario["person"]["vibe"] },
                  }))
                }
              />
            </div>
            <div className="mt-6 rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-900">
              <div className="font-semibold">Scenario preview</div>
              <div className="mt-2 text-slate-900">
                <span className="font-medium">{scenario.person.title}</span> ({scenario.person.yearsExp} yrs) •{" "}
                {scenario.firmType} • {scenario.group} •{" "}
                <span className="text-slate-600">vibe:</span>{" "}
                <span className="font-medium text-slate-900">{scenario.person.vibe}</span>
              </div>
              <div className="mt-2 text-slate-900">{scenario.twist}</div>
              <div className="mt-2 text-slate-900">
                <span className="text-slate-600">Goal:</span>{" "}
                <span className="font-semibold text-slate-900">Referral</span>
              </div>
            </div>
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Session Controls
                </div>
                <div className="mt-1 text-lg font-semibold text-slate-900">Run your mock chat</div>
              </div>
              <Badge tone={statusTone}>{statusLabel}</Badge>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              {!isListening ? (
                <Button onClick={startListening} type="button">
                  Start Listening
                </Button>
              ) : (
                <Button variant="secondary" onClick={stopListening} type="button">
                  Stop Listening
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={getFeedback}
                disabled={!transcript.trim() || fetchingFeedback}
                type="button"
              >
                {fetchingFeedback ? "Generating..." : "Get Feedback"}
              </Button>
            </div>
            <div className="mt-4 text-sm text-slate-700">
              Speak naturally. We transcribe your response and generate coaching feedback.
            </div>
            {speechError ? (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {speechError}
              </div>
            ) : null}
            {feedbackError ? (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {feedbackError}
              </div>
            ) : null}

            {!speechSupported ? (
              <div className="mt-3 text-sm text-amber-700">
                Speech recognition not supported—use Chrome or enable fallback.
              </div>
            ) : null}
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold text-slate-900">Transcript</div>
              {isListening ? <Badge tone="success">Listening…</Badge> : <Badge>Idle</Badge>}
            </div>
            <div className="mt-3 min-h-[160px] whitespace-pre-wrap text-sm text-slate-800">
              {transcript || interimTranscript ? (
                <>
                  {transcript ? <span>{transcript}</span> : null}
                  {interimTranscript ? (
                    <span className="text-slate-500"> {interimTranscript}</span>
                  ) : null}
                </>
              ) : (
                "Start listening to capture your response."
              )}
            </div>
          </Card>
          </motion.div>
        </div>

        <div className="flex flex-col gap-6">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.3 }}
          >
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">Coaching panel</div>
                <Badge tone="neutral">Live</Badge>
              </div>
              <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm text-slate-900">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Next best question
                </div>
                <div className="mt-2 font-medium text-slate-900">{nextBestQuestion}</div>
              </div>
              <div className="mt-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Feedback
                </div>
                <div className="mt-2 min-h-[220px] whitespace-pre-wrap text-sm text-slate-800">
                  {feedback || "Feedback will appear here after you click Get Feedback."}
                </div>
              </div>
            </Card>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
