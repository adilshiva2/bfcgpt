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

type InterviewState = "idle" | "listening" | "thinking" | "speaking" | "error";

type ScenarioPayload = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  difficulty: string;
  goal: "referral";
};

type Message = {
  role: "user" | "interviewer";
  content: string;
};

const roleTracks: RoleTrack[] = [
  "Investment Banking",
  "Private Equity",
  "Equity Research",
  "Sales & Trading",
  "Venture Capital",
  "Corporate Development",
];

const difficultyOptions = ["Easy", "Standard", "Hard"] as const;

type Difficulty = (typeof difficultyOptions)[number];

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
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentUserTurnRef = useRef("");

  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [difficulty, setDifficulty] = useState<Difficulty>("Standard");
  const [messages, setMessages] = useState<Message[]>([]);

  const [interviewState, setInterviewState] = useState<InterviewState>("idle");
  const [interviewError, setInterviewError] = useState<string | null>(null);

  const [speechSupported, setSpeechSupported] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptInterim, setTranscriptInterim] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);

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
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
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

  const stopSpeaking = useCallback(() => {
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
    }
    setInterviewState("listening");
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setTtsError(null);

      const speakText = trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: speakText }),
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
          setInterviewState("speaking");
          await audioEl.play();
          setAudioNeedsClick(false);
        } catch {
          setAudioNeedsClick(true);
          throw new Error("Audio playback blocked. Click to enable audio.");
        }
        audioEl.onended = () => {
          URL.revokeObjectURL(audioUrl);
          setInterviewState("listening");
        };
      } catch (err) {
        setTtsError(err instanceof Error ? err.message : "TTS failed.");
        setInterviewState("listening");
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

  const scenarioPayload: ScenarioPayload = useMemo(
    () => ({
      track: scenario.track,
      firmType: scenario.firmType,
      group: scenario.group,
      interviewerVibe: scenario.person.vibe,
      difficulty,
      goal: "referral",
    }),
    [scenario, difficulty]
  );

  const callInterviewer = useCallback(
    async (nextMessages: Message[]) => {
      setInterviewState("thinking");
      setInterviewError(null);
      try {
        const res = await fetch("/api/interviewer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextMessages, scenario: scenarioPayload }),
        });

        const text = await res.text();
        let payload: Record<string, unknown> = {};
        try {
          payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          payload = {};
        }

        if (!res.ok) {
          const requestId = payload.requestId as string | undefined;
          const errorMessage =
            (payload.error as string) ||
            (text && text.length < 240 ? text : "") ||
            res.statusText;
          const withId = requestId ? `${errorMessage} (Request ID: ${requestId})` : errorMessage;
          setInterviewError(withId);
          setInterviewState("error");
          return;
        }

        const interviewerText = (payload.interviewerText as string) || "";
        if (!interviewerText) {
          setInterviewError("Empty interviewer response.");
          setInterviewState("error");
          return;
        }

        setMessages((prev) => [...prev, { role: "interviewer", content: interviewerText }]);
        await speak(interviewerText);
      } catch (err) {
        setInterviewError(err instanceof Error ? err.message : "Interview request failed.");
        setInterviewState("error");
      }
    },
    [scenarioPayload, speak]
  );

  const finalizeTurn = useCallback(async () => {
    const text = currentUserTurnRef.current.trim();
    if (!text) return;
    currentUserTurnRef.current = "";
    const nextMessages: Message[] = [...messages, { role: "user", content: text }];
    await callInterviewer(nextMessages);
  }, [callInterviewer, messages]);

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

      if (interviewState === "speaking") {
        stopSpeaking();
      }

      const trimmedFinal = finalText.trim();
      if (trimmedFinal) {
        currentUserTurnRef.current = `${currentUserTurnRef.current} ${trimmedFinal}`.trim();
        setMessages((prev) => [...prev, { role: "user", content: trimmedFinal }]);
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
        }
        silenceTimerRef.current = setTimeout(() => {
          void finalizeTurn();
        }, 1200);
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
    setInterviewState("listening");
  }, [finalizeTurn, interviewState, isTranscribing, speechSupported, stopSpeaking]);

  const stopTranscription = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsTranscribing(false);
    setTranscriptInterim("");
    setInterviewState("idle");
  }, []);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(scenario.track);
    setScenario(sc);
  }, [scenario.track]);

  const startInterview = useCallback(async () => {
    setMessages([]);
    currentUserTurnRef.current = "";
    setInterviewError(null);
    setTranscriptInterim("");
    await callInterviewer([]);
  }, [callInterviewer]);

  const sendAnswer = useCallback(async () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    await finalizeTurn();
  }, [finalizeTurn]);

  const endInterview = useCallback(() => {
    stopTranscription();
    stopSpeaking();
    setMessages([]);
    currentUserTurnRef.current = "";
    setInterviewState("idle");
    setInterviewError(null);
  }, [stopSpeaking, stopTranscription]);

  const summaryText = useMemo(() => {
    const lastInterviewer = [...messages].reverse().find((m) => m.role === "interviewer");
    return lastInterviewer?.content || "";
  }, [messages]);

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
                <Select
                  label="Difficulty"
                  value={difficulty}
                  options={difficultyOptions.map((value) => ({ value, label: value }))}
                  onChange={(value) => setDifficulty(value as Difficulty)}
                  className="md:col-span-2"
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
                    Interview Controls
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    Mock interview loop (TTS)
                  </div>
                </div>
                <Badge tone={interviewState === "speaking" ? "warning" : "neutral"}>
                  {interviewState}
                </Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button onClick={startInterview} type="button">
                  Start Interview
                </Button>
                <Button variant="secondary" onClick={sendAnswer} type="button">
                  Send Answer
                </Button>
                <Button variant="secondary" onClick={stopSpeaking} type="button">
                  Stop Speaking
                </Button>
                <Button variant="ghost" onClick={endInterview} type="button">
                  End Interview
                </Button>
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
              {interviewError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {interviewError}
                </div>
              ) : null}
              {ttsError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {ttsError}
                </div>
              ) : null}
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="text-base font-semibold text-slate-900">Conversation</div>
              <div className="mt-4 space-y-4">
                {messages.length === 0 ? (
                  <div className="text-sm text-slate-600">No messages yet.</div>
                ) : (
                  messages.map((msg, idx) => (
                    <div key={idx} className="text-sm">
                      <div className="font-semibold text-slate-700">
                        {msg.role === "interviewer" ? "Interviewer" : "You"}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-slate-900">{msg.content}</div>
                    </div>
                  ))
                )}
                {transcriptInterim ? (
                  <div className="text-sm text-slate-500">You (live): {transcriptInterim}</div>
                ) : null}
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
                <div className="text-base font-semibold text-slate-900">TTS Debug</div>
                <Badge tone="neutral">ElevenLabs</Badge>
              </div>
              <div className="mt-4 text-sm text-slate-700">
                ElevenLabs voice output without WebRTC.
              </div>
              {debugTts ? (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Last TTS call</div>
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
