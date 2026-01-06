"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { QuestionBankMeta } from "@/lib/question-bank";
import {
  MockInterviewSettings,
  questionStageOptions,
  questionTypeOptions,
} from "@/lib/mock-interview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

type InterviewStatus = "idle" | "speaking_intro" | "listening" | "thinking" | "speaking" | "paused";

type Message = {
  role: "interviewer" | "user";
  content: string;
};

type StartResponse = {
  interviewerText: string;
  realtimeFeedback?: string;
  questionId: string;
  requestId?: string;
};

type TurnResponse = {
  interviewerText: string;
  realtimeFeedback?: string;
  nextQuestionId: string;
  done: boolean;
  requestId?: string;
};

type EndResponse = {
  finalSummary: string;
  requestId?: string;
};

function parseJsonRecord(text: string) {
  if (!text) return {} as Record<string, unknown>;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type Props = {
  meta: QuestionBankMeta;
};

function getSpeechRecognition(): SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionImpl) return null;
  return new SpeechRecognitionImpl();
}

export default function MockInterviewClient({ meta }: Props) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentUserTurnRef = useRef("");
  const conversationRef = useRef<Message[]>([]);
  const askedIdsRef = useRef<string[]>([]);
  const lastQuestionIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const finalizeTurnRef = useRef<() => void>(() => {});
  const startTranscriptionRef = useRef<() => void>(() => {});

  const [status, setStatus] = useState<InterviewStatus>("idle");
  const [speechSupported, setSpeechSupported] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [audioNeedsClick, setAudioNeedsClick] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Message[]>([]);
  const [realtimeFeedback, setRealtimeFeedback] = useState<string>("");
  const [finalSummary, setFinalSummary] = useState<string>("");
  const [apiError, setApiError] = useState<string | null>(null);

  const [settings, setSettings] = useState<MockInterviewSettings>({
    firm: meta.firms[0] || "All",
    stage: "all",
    questionTypes: [],
    difficulty: "any",
    randomize: true,
    followUps: true,
  });

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


  const firmOptions = useMemo(
    () => [{ value: "All", label: "All" }, ...meta.firms.map((firm) => ({ value: firm, label: firm }))],
    [meta.firms]
  );

  const stageOptions = useMemo(
    () => [
      { value: "all", label: "All stages" },
      ...questionStageOptions.map((stage) => ({
        value: stage,
        label: stage.replace(/_/g, " "),
      })),
    ],
    []
  );

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
        const audioUrl = URL.createObjectURL(blob);
        const audioEl = ensureTtsAudio();
        audioEl.pause();
        audioEl.currentTime = 0;
        audioEl.src = audioUrl;
        setStatus((prev) => (prev === "paused" ? prev : "speaking"));
        try {
          await audioEl.play();
          setAudioNeedsClick(false);
        } catch {
          setAudioNeedsClick(true);
          throw new Error("Audio playback blocked. Click to enable audio.");
        }
        audioEl.onended = () => {
          URL.revokeObjectURL(audioUrl);
          setStatus((prev) => (prev === "paused" ? prev : "listening"));
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

  const updateConversation = useCallback((next: Message[]) => {
    conversationRef.current = next;
    setConversation(next);
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

      if (status === "speaking") {
        stopSpeaking();
        setStatus("listening");
      }

      const trimmedFinal = finalText.trim();
      if (trimmedFinal) {
        currentUserTurnRef.current = `${currentUserTurnRef.current} ${trimmedFinal}`.trim();
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
        }
        silenceTimerRef.current = setTimeout(() => {
          void finalizeTurnRef.current();
        }, 1200);
      }
      setInterimTranscript(interimText.trim());
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
      setInterimTranscript("");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsTranscribing(true);
    setStatus("listening");
  }, [isTranscribing, speechSupported, status, stopSpeaking]);

  useEffect(() => {
    startTranscriptionRef.current = startTranscription;
  }, [startTranscription]);

  const stopTranscription = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsTranscribing(false);
    setInterimTranscript("");
  }, []);

  const startInterview = useCallback(async () => {
    setApiError(null);
    setFinalSummary("");
    setRealtimeFeedback("");
    setSpeechError(null);
    currentUserTurnRef.current = "";
    updateConversation([]);
    askedIdsRef.current = [];
    lastQuestionIdRef.current = null;

    setStatus("speaking_intro");
    try {
      const res = await fetch("/api/mock-interview/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const text = await res.text();
      const payload = parseJsonRecord(text);

      if (!res.ok) {
        const msg = (payload.error as string) || res.statusText;
        const requestId = payload.requestId as string | undefined;
        setApiError(requestId ? `${msg} (Request ID: ${requestId})` : msg);
        setStatus("idle");
        return;
      }

      const response = payload as StartResponse;
      updateConversation([{ role: "interviewer", content: response.interviewerText }]);
      setRealtimeFeedback(response.realtimeFeedback || "");
      lastQuestionIdRef.current = response.questionId;
      askedIdsRef.current = [response.questionId];
      await speak(response.interviewerText);
      startTranscriptionRef.current();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to start interview.");
      setStatus("idle");
    }
  }, [settings, speak, updateConversation]);

  const finalizeTurn = useCallback(async () => {
    if (inFlightRef.current) return;
    const lastUserTurn = currentUserTurnRef.current.trim();
    if (!lastUserTurn) return;
    currentUserTurnRef.current = "";

    const updatedConversation: Message[] = [
      ...conversationRef.current,
      { role: "user", content: lastUserTurn },
    ];
    updateConversation(updatedConversation);

    if (!lastQuestionIdRef.current) return;
    setStatus("thinking");
    inFlightRef.current = true;

    try {
      const res = await fetch("/api/mock-interview/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings,
          conversation: updatedConversation.slice(-6),
          lastQuestionId: lastQuestionIdRef.current,
          askedQuestionIds: askedIdsRef.current,
          lastUserTurn,
        }),
      });
      const text = await res.text();
      const payload = parseJsonRecord(text);

      if (!res.ok) {
        const msg = (payload.error as string) || res.statusText;
        const requestId = payload.requestId as string | undefined;
        setApiError(requestId ? `${msg} (Request ID: ${requestId})` : msg);
        setStatus("idle");
        return;
      }

      const response = payload as TurnResponse;
      setRealtimeFeedback(response.realtimeFeedback || "");
      updateConversation([
        ...updatedConversation,
        { role: "interviewer", content: response.interviewerText },
      ]);

      if (response.nextQuestionId && !askedIdsRef.current.includes(response.nextQuestionId)) {
        askedIdsRef.current = [...askedIdsRef.current, response.nextQuestionId];
      }
      lastQuestionIdRef.current = response.nextQuestionId;
      await speak(response.interviewerText);
      if (!response.done) {
        startTranscriptionRef.current();
      } else {
        setStatus("idle");
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to process turn.");
      setStatus("idle");
    } finally {
      inFlightRef.current = false;
    }
  }, [settings, speak, updateConversation]);

  useEffect(() => {
    finalizeTurnRef.current = finalizeTurn;
  }, [finalizeTurn]);

  const pauseInterview = useCallback(() => {
    stopTranscription();
    stopSpeaking();
    setStatus("paused");
  }, [stopSpeaking, stopTranscription]);

  const resumeInterview = useCallback(() => {
    if (status !== "paused") return;
    startTranscriptionRef.current();
  }, [status]);

  const endInterview = useCallback(async () => {
    stopTranscription();
    stopSpeaking();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }

    const lastUserTurn = currentUserTurnRef.current.trim();
    if (lastUserTurn) {
      const updatedConversation: Message[] = [
        ...conversationRef.current,
        { role: "user", content: lastUserTurn },
      ];
      updateConversation(updatedConversation);
      currentUserTurnRef.current = "";
    }

    setStatus("idle");
    try {
      const res = await fetch("/api/mock-interview/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings,
          askedQuestionIds: askedIdsRef.current,
          conversation: conversationRef.current.slice(-8),
        }),
      });
      const text = await res.text();
      const payload = parseJsonRecord(text);

      if (!res.ok) {
        const msg = (payload.error as string) || res.statusText;
        const requestId = payload.requestId as string | undefined;
        setApiError(requestId ? `${msg} (Request ID: ${requestId})` : msg);
        return;
      }

      const response = payload as EndResponse;
      setFinalSummary(response.finalSummary);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to end interview.");
    }
  }, [settings, stopSpeaking, stopTranscription, updateConversation]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-10">
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="flex flex-col gap-6">
          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Mock Interview Settings
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    Choose question bank filters
                  </div>
                </div>
                <Badge tone="neutral">{meta.firms.length} firms</Badge>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Select
                  label="Firm"
                  value={settings.firm}
                  options={firmOptions}
                  onChange={(value) => setSettings((prev) => ({ ...prev, firm: value }))}
                />
                <Select
                  label="Stage"
                  value={settings.stage}
                  options={stageOptions}
                  onChange={(value) =>
                    setSettings((prev) => ({ ...prev, stage: value as MockInterviewSettings["stage"] }))
                  }
                />
                <Select
                  label="Difficulty"
                  value={String(settings.difficulty)}
                  options={[
                    { value: "any", label: "Any" },
                    { value: "1", label: "1" },
                    { value: "2", label: "2" },
                    { value: "3", label: "3" },
                  ]}
                  onChange={(value) =>
                    setSettings((prev) => ({
                      ...prev,
                      difficulty:
                        value === "any" ? "any" : (Number.parseInt(value, 10) as 1 | 2 | 3),
                    }))
                  }
                />
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">Question types</div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-700">
                    {questionTypeOptions.map((type) => (
                      <label key={type} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={settings.questionTypes.includes(type)}
                          onChange={(event) => {
                            setSettings((prev) => ({
                              ...prev,
                              questionTypes: event.target.checked
                                ? [...prev.questionTypes, type]
                                : prev.questionTypes.filter((item) => item !== type),
                            }));
                          }}
                        />
                        <span>{type.replace(/_/g, " ")}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.randomize}
                    onChange={(event) =>
                      setSettings((prev) => ({ ...prev, randomize: event.target.checked }))
                    }
                  />
                  <span>Randomize questions</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.followUps}
                    onChange={(event) =>
                      setSettings((prev) => ({ ...prev, followUps: event.target.checked }))
                    }
                  />
                  <span>Allow 1 follow-up before moving on</span>
                </label>
              </div>
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Mock Interview Controls
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">Live interview loop</div>
                </div>
                <Badge tone="neutral">{status.replace(/_/g, " ")}</Badge>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <Button onClick={startInterview} type="button">
                  Start Interview
                </Button>
                <Button variant="secondary" onClick={pauseInterview} type="button">
                  Pause
                </Button>
                <Button variant="secondary" onClick={resumeInterview} type="button">
                  Resume
                </Button>
                <Button variant="secondary" onClick={endInterview} type="button">
                  End Interview
                </Button>
              </div>

              {audioNeedsClick ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  Audio playback blocked.{" "}
                  <Button variant="ghost" onClick={retryAudio} className="px-2 py-1 text-xs">
                    Click to enable audio
                  </Button>
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
              {apiError ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {apiError}
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
                {conversation.length === 0 ? (
                  <div className="text-sm text-slate-600">No messages yet.</div>
                ) : (
                  conversation.map((msg, idx) => (
                    <div key={idx} className="text-sm">
                      <div className="font-semibold text-slate-700">
                        {msg.role === "interviewer" ? "Interviewer" : "You"}
                      </div>
                      <div className="mt-1 whitespace-pre-wrap text-slate-900">{msg.content}</div>
                    </div>
                  ))
                )}
                {interimTranscript ? (
                  <div className="text-sm text-slate-500">You (live): {interimTranscript}</div>
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
                <div className="text-base font-semibold text-slate-900">Realtime Coaching</div>
                <Badge tone="neutral">Live</Badge>
              </div>
              <div className="mt-4 whitespace-pre-wrap text-sm text-slate-700">
                {realtimeFeedback || "Coaching updates after each response."}
              </div>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.3 }}
          >
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">Final Summary</div>
                <Badge tone="neutral">End of interview</Badge>
              </div>
              <div className="mt-4 min-h-[200px] whitespace-pre-wrap text-sm text-slate-800">
                {finalSummary || "End the interview to see your summary."}
              </div>
              {finalSummary ? (
                <Button
                  variant="secondary"
                  type="button"
                  className="mt-4"
                  onClick={() => speak(finalSummary)}
                >
                  Speak summary
                </Button>
              ) : null}
            </Card>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
