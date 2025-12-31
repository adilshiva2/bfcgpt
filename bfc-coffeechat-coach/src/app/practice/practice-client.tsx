"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { generateScenario, RoleTrack, Scenario } from "@/lib/networking-scenarios";

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
  const [track, setTrack] = useState<RoleTrack>("Investment Banking");
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);

  const [speechSupported, setSpeechSupported] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState<string>("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [fetchingFeedback, setFetchingFeedback] = useState(false);

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
    const sc = generateScenario(track);
    setScenario(sc);
  }, [track]);

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

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText || res.statusText);
      }

      const data = await res.json();
      setFeedback(data?.feedback || "");
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to fetch feedback.");
    } finally {
      setFetchingFeedback(false);
    }
  }, [fetchingFeedback, scenario, transcript]);

  const transcriptText = [transcript, interimTranscript].filter(Boolean).join(" ");

  return (
    <div className="flex h-[calc(100vh-6rem)] w-full gap-4">
      <div className="flex flex-1 flex-col gap-4">
        <div className="rounded-xl border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Track</label>
              <select
                className="rounded-md border px-3 py-2"
                value={track}
                onChange={(e) => setTrack(e.target.value as RoleTrack)}
              >
                {roleTracks.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="rounded-md border px-4 py-2"
              onClick={rerollScenarioOnly}
              title="Preview a scenario before starting"
            >
              Randomize scenario
            </button>

            {!isListening ? (
              <button
                className="rounded-md bg-black px-4 py-2 text-white disabled:opacity-60"
                onClick={startListening}
              >
                Start Listening
              </button>
            ) : (
              <button className="rounded-md bg-red-600 px-4 py-2 text-white" onClick={stopListening}>
                Stop Listening
              </button>
            )}

            <button
              className="rounded-md border px-4 py-2 disabled:opacity-60"
              onClick={getFeedback}
              disabled={!transcript.trim() || fetchingFeedback}
            >
              {fetchingFeedback ? "Getting feedback..." : "Get Feedback"}
            </button>

            <div className="ml-auto text-sm">
              Status: <span className="font-semibold">{isListening ? "Listening" : "Idle"}</span>
            </div>
          </div>

          {speechError ? <div className="mt-3 text-sm text-red-600">{speechError}</div> : null}
          {feedbackError ? <div className="mt-2 text-sm text-red-600">{feedbackError}</div> : null}

          {!speechSupported ? (
            <div className="mt-3 text-sm text-amber-700">
              Speech recognition not supported—use Chrome or enable fallback
            </div>
          ) : null}

          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-900">
            <div className="font-semibold">Scenario</div>
            <div className="mt-1 text-slate-900">
              <span className="font-medium">{scenario.person.title}</span> ({scenario.person.yearsExp} yrs) •{" "}
              {scenario.firmType} • {scenario.group} • <span className="text-slate-600">vibe:</span>{" "}
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
            Talk normally. Your speech is transcribed live and used for coaching feedback.
          </div>
        </div>

        <div className="rounded-xl border p-4">
          <div className="text-base font-semibold">Transcript</div>
          <div className="mt-2 min-h-[140px] whitespace-pre-wrap text-sm text-gray-800">
            {transcriptText || "Start listening to capture your response."}
          </div>
        </div>
      </div>

      <div className="w-[420px] shrink-0 rounded-xl border p-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold">Coach feedback</div>
        </div>
        <div className="mt-4 min-h-[200px] whitespace-pre-wrap text-sm text-gray-800">
          {feedback || "Feedback will appear here after you click Get Feedback."}
        </div>
      </div>
    </div>
  );
}
