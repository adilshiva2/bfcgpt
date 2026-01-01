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
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);

  const [speechSupported, setSpeechSupported] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptFinal, setTranscriptFinal] = useState("");
  const [transcriptInterim, setTranscriptInterim] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState<string>("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [fetchingFeedback, setFetchingFeedback] = useState(false);

  const [audioNeedsClick, setAudioNeedsClick] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<number | null>(null);
  const [ttsContentType, setTtsContentType] = useState<string>("-");
  const [ttsBytes, setTtsBytes] = useState<number | null>(null);

  const debugTts = process.env.NEXT_PUBLIC_DEBUG_TTS === "true";

  const firmTypeOptions = useMemo(
    () => firmTypesByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const groupOptions = useMemo(
    () => groupsByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const vibeOptions = useMemo(() => vibes.map((value) => ({ value, label: value })), []);

  useEffect(() => {
    setSpeechSupported(
      typeof window !== "undefined" &&
        ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  const ensureTtsAudio = useCallback(() => {
    if (!ttsAudioRef.current) {
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "");
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      ttsAudioRef.current = audioEl;
    }
    return ttsAudioRef.current;
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setTtsError(null);

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });

        setTtsStatus(res.status);
        setTtsContentType(res.headers.get("content-type") || "-");

        if (!res.ok) {
          const errorText = await res.text();
          let payload: { error?: string } = {};
          try {
            payload = errorText ? (JSON.parse(errorText) as { error?: string }) : {};
          } catch {
            payload = {};
          }
          throw new Error(payload.error || errorText || res.statusText);
        }

        const blob = await res.blob();
        setTtsBytes(blob.size);
        const audioUrl = URL.createObjectURL(blob);
        const audioEl = ensureTtsAudio();
        audioEl.pause();
        audioEl.currentTime = 0;
        audioEl.src = audioUrl;
        try {
          await audioEl.play();
          setAudioNeedsClick(false);
        } catch {
          setAudioNeedsClick(true);
          throw new Error("Audio playback blocked. Click to enable audio.");
        }
        audioEl.onended = () => {
          URL.revokeObjectURL(audioUrl);
        };
      } catch (err) {
        setTtsError(err instanceof Error ? err.message : "TTS failed.");
      }
    },
    [ensureTtsAudio]
  );

  const retryAudio = useCallback(async () => {
    if (!ttsAudioRef.current) return;
    try {
      await ttsAudioRef.current.play();
      setAudioNeedsClick(false);
    } catch {
      setAudioNeedsClick(true);
    }
  }, []);

  const startTranscription = useCallback(() => {
    setSpeechError(null);
    if (!speechSupported) {
      setSpeechError("Speech recognition not supported—use Chrome or enable fallback.");
      return;
    }
    if (isTranscribing) return;

    const recognition = getSpeechRecognition();
    if (!recognition) {
      setSpeechError("Speech recognition not supported—use Chrome or enable fallback.");
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
        setTranscriptFinal((prev) => [prev, trimmedFinal].filter(Boolean).join(" "));
      }
      setTranscriptInterim(interimText.trim());
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setSpeechError("Microphone blocked. Click the lock icon → allow microphone → reload.");
      } else {
        setSpeechError(`Speech recognition error: ${event.error}`);
      }
      setIsTranscribing(false);
    };

    recognition.onend = () => {
      setIsTranscribing(false);
      setTranscriptInterim("");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsTranscribing(true);
  }, [isTranscribing, speechSupported]);

  const stopTranscription = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsTranscribing(false);
    setTranscriptInterim("");
  }, []);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(scenario.track);
    setScenario(sc);
  }, [scenario.track]);

  const getFeedback = useCallback(async () => {
    const trimmedTranscript = transcriptFinal.trim();
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
        throw new Error(errorMessage || "Unable to get feedback.");
      }

      const feedbackText = typeof payload.feedback === "string" ? payload.feedback : "";
      setFeedback(feedbackText || "No feedback returned.");
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : "Failed to fetch feedback.");
    } finally {
      setFetchingFeedback(false);
    }
  }, [fetchingFeedback, scenario, transcriptFinal]);

  const summaryText = useMemo(() => {
    if (!feedback) return "";
    const lines = feedback.split("\n").filter(Boolean).slice(0, 3).join(" ");
    return lines.slice(0, 500);
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
                    Transcription
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    Browser SpeechRecognition
                  </div>
                </div>
                <Badge tone={isTranscribing ? "success" : "neutral"}>
                  {isTranscribing ? "Transcribing" : "Idle"}
                </Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                {!isTranscribing ? (
                  <Button onClick={startTranscription} type="button">
                    Start Transcription
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={stopTranscription} type="button">
                    Stop Transcription
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={getFeedback}
                  disabled={!transcriptFinal.trim() || fetchingFeedback}
                  type="button"
                >
                  {fetchingFeedback ? "Getting feedback..." : "Get Feedback"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => speak("Audio test. If you can hear this, ElevenLabs is working.")}
                  type="button"
                >
                  Test ElevenLabs Voice
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    speak(summaryText ? `Here’s your feedback. ${summaryText}` : "No feedback yet.")
                  }
                  type="button"
                  disabled={!summaryText}
                >
                  Speak Feedback
                </Button>
              </div>
              {audioNeedsClick ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  Audio playback blocked. <Button variant="ghost" onClick={retryAudio}>Click to enable audio</Button>
                </div>
              ) : null}
              {!speechSupported ? (
                <div className="mt-3 text-sm text-amber-700">
                  Speech recognition not supported—use Chrome or enable fallback.
                </div>
              ) : null}
              {speechError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {speechError}
                </div>
              ) : null}
              {feedbackError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {feedbackError}
                </div>
              ) : null}
              {ttsError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {ttsError}
                </div>
              ) : null}
              <div className="mt-4 min-h-[140px] whitespace-pre-wrap text-sm text-slate-800">
                {transcriptFinal || transcriptInterim ? (
                  <>
                    {transcriptFinal ? <span>{transcriptFinal}</span> : null}
                    {transcriptInterim ? <span className="text-slate-500"> {transcriptInterim}</span> : null}
                  </>
                ) : (
                  "Start transcription to capture your response."
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
                <div className="text-base font-semibold text-slate-900">Coach feedback</div>
                <Badge tone="neutral">Text</Badge>
              </div>
              <div className="mt-4 min-h-[220px] whitespace-pre-wrap text-sm text-slate-800">
                {feedback || "Feedback will appear here after you click Get Feedback."}
              </div>
              {debugTts ? (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">TTS Debug</div>
                  <div className="mt-2 space-y-1">
                    <div>Status: {ttsStatus ?? "-"}</div>
                    <div>Content-Type: {ttsContentType}</div>
                    <div>Blob size: {ttsBytes ?? "-"} bytes</div>
                  </div>
                </div>
              ) : null}
            </Card>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
