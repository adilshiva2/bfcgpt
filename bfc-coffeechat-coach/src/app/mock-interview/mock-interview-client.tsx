"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { QuestionBankMeta } from "@/lib/question-bank";
import {
  type InterviewMode,
  type MockInterviewSettings,
  interviewModeConfigs,
  interviewModeOptions,
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

type PlanItem = {
  qIndex: number;
  type:
    | "behavioral"
    | "accounting"
    | "valuation"
    | "lbo"
    | "merger_math"
    | "market"
    | "brainteaser"
    | "other";
  interviewerQuestion: string;
  expectedRubric: string;
  idealAnswerOutline: string;
};

type PlanResponse = {
  plan: PlanItem[];
  seedCount: number;
  requestId?: string;
};

type GradeResponse = {
  score0to10: number;
  strengths: string[];
  gaps: string[];
  correctedAnswerOutline: string;
  nextBestSentence: string;
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
  const inFlightRef = useRef(false);
  const finalizeTurnRef = useRef<() => void>(() => {});
  const startTranscriptionRef = useRef<() => void>(() => {});
  const statusRef = useRef<InterviewStatus>("idle");
  const holdToTalkRef = useRef(false);
  const isTranscribingRef = useRef(false);

  const [status, setStatus] = useState<InterviewStatus>("idle");
  const [speechSupported, setSpeechSupported] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [audioNeedsClick, setAudioNeedsClick] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Message[]>([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [seedCount, setSeedCount] = useState<number | null>(null);
  const [finalSummary, setFinalSummary] = useState<string>("");
  const [feedback, setFeedback] = useState<GradeResponse | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [pendingNext, setPendingNext] = useState(false);
  const [holdToTalk, setHoldToTalk] = useState(false);

  const [interviewMode, setInterviewMode] = useState<InterviewMode>("standard");
  const modeConfig = interviewModeConfigs[interviewMode];

  const [settings, setSettings] = useState<MockInterviewSettings>({
    firm: meta.firms[0] || "All",
    stage: "first_round",
    questionTypes: ["all"],
    randomize: true,
    followUps: true,
  });
  const [numQuestions, setNumQuestions] = useState(6);
  const [showOtherFirms, setShowOtherFirms] = useState(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    holdToTalkRef.current = holdToTalk;
  }, [holdToTalk]);

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

  // When interview mode changes, update suggested question types and count
  useEffect(() => {
    const config = interviewModeConfigs[interviewMode];
    setSettings((prev: MockInterviewSettings) => ({
      ...prev,
      questionTypes: config.suggestedTypes.length > 0 ? config.suggestedTypes : ["all"],
    }));
    setNumQuestions(config.defaultNumQuestions);
  }, [interviewMode]);

  const firmOptions = useMemo(() => {
    const base = [{ value: "All", label: "All" }, ...meta.firms.map((firm) => ({ value: firm, label: firm }))];
    if (showOtherFirms) {
      base.push({ value: "Other", label: "Other / Unclassified" });
    }
    return base;
  }, [meta.firms, showOtherFirms]);

  const stageOptions = useMemo(
    () =>
      questionStageOptions.map((stage) => ({
        value: stage,
        label: stage.replace(/_/g, " "),
      })),
    []
  );

  useEffect(() => {
    if (!showOtherFirms && settings.firm === "Other") {
      setSettings((prev: MockInterviewSettings) => ({ ...prev, firm: meta.firms[0] || "All" }));
    }
  }, [meta.firms, settings.firm, showOtherFirms]);

  const allTypesSelected = useMemo(() => {
    if (settings.questionTypes.includes("all")) return true;
    return questionTypeOptions.every((type) => settings.questionTypes.includes(type));
  }, [settings.questionTypes]);

  const toggleAllTypes = (checked: boolean) => {
    if (checked) {
      setSettings((prev: MockInterviewSettings) => ({ ...prev, questionTypes: ["all"] }));
      return;
    }
    setSettings((prev: MockInterviewSettings) => ({ ...prev, questionTypes: [questionTypeOptions[0]] }));
  };

  const toggleType = (type: typeof questionTypeOptions[number], checked: boolean) => {
    if (settings.questionTypes.includes("all")) {
      setSettings((prev: MockInterviewSettings) => ({ ...prev, questionTypes: checked ? [type] : [] }));
      return;
    }
    const next = checked
      ? [...settings.questionTypes, type]
      : settings.questionTypes.filter(
          (item: MockInterviewSettings["questionTypes"][number]) => item !== type
        );
    const collapsed =
      next.length === questionTypeOptions.length ? (["all"] as MockInterviewSettings["questionTypes"]) : next;
    setSettings((prev: MockInterviewSettings) => ({ ...prev, questionTypes: collapsed }));
  };

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

  /**
   * speak() returns a Promise that resolves when audio playback ENDS (not when
   * it starts). This ensures callers can sequence: speak → then start listening,
   * preventing the microphone from picking up TTS audio output.
   */
  const speak = useCallback(
    (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve();
      setTtsError(null);
      const speakText = trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;

      return new Promise<void>((resolve) => {
        void (async () => {
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
              // Reset status so the UI doesn't stay stuck on "speaking"
              setStatus((prev) =>
                prev === "speaking" || prev === "speaking_intro" ? "listening" : prev
              );
              resolve();
              return;
            }
            audioEl.onended = () => {
              URL.revokeObjectURL(audioUrl);
              setStatus((prev) => (prev === "paused" ? prev : "listening"));
              resolve();
            };
            audioEl.onerror = () => {
              setStatus((prev) =>
                prev === "speaking" || prev === "speaking_intro" ? "listening" : prev
              );
              resolve();
            };
          } catch (err) {
            setTtsError(err instanceof Error ? err.message : "TTS failed.");
            // Reset status so the UI doesn't stay stuck on "speaking"
            setStatus((prev) =>
              prev === "speaking" || prev === "speaking_intro" ? "listening" : prev
            );
            resolve();
          }
        })();
      });
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

  const stopTranscription = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    isTranscribingRef.current = false;
    setIsTranscribing(false);
    setInterimTranscript("");
  }, []);

  const startTranscription = useCallback(() => {
    setSpeechError(null);
    if (!speechSupported) {
      setSpeechError("Speech recognition not supported — use Chrome or enable fallback.");
      return;
    }
    if (isTranscribingRef.current) return;

    const recognition = getSpeechRecognition();
    if (!recognition) {
      setSpeechError("Speech recognition not supported — use Chrome or enable fallback.");
      return;
    }

    recognition.continuous = !holdToTalkRef.current;
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

      // Use ref to avoid stale closure — status state may be outdated
      if (statusRef.current === "speaking") {
        stopSpeaking();
        setStatus("listening");
      }

      const trimmedFinal = finalText.trim();
      if (trimmedFinal) {
        currentUserTurnRef.current = `${currentUserTurnRef.current} ${trimmedFinal}`.trim();
        if (!holdToTalkRef.current) {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = setTimeout(() => {
            void finalizeTurnRef.current();
          }, 900);
        }
      }
      setInterimTranscript(interimText.trim());
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setSpeechError("Microphone blocked. Click the lock icon → allow microphone → reload.");
        isTranscribingRef.current = false;
        setIsTranscribing(false);
      } else if (event.error === "network" || event.error === "no-speech") {
        // Transient errors — let onend auto-restart without showing a permanent error
      } else if (event.error !== "aborted") {
        setSpeechError(`Speech recognition error: ${event.error}`);
        isTranscribingRef.current = false;
        setIsTranscribing(false);
      }
    };

    recognition.onend = () => {
      isTranscribingRef.current = false;
      setIsTranscribing(false);
      setInterimTranscript("");
      if (holdToTalkRef.current && currentUserTurnRef.current.trim()) {
        void finalizeTurnRef.current();
      } else if (
        !holdToTalkRef.current &&
        statusRef.current === "listening"
      ) {
        // Chrome kills continuous recognition periodically, or network
        // errors cause it to stop — auto-restart in either case
        setTimeout(() => startTranscriptionRef.current(), 300);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    isTranscribingRef.current = true;
    setIsTranscribing(true);
    setStatus("listening");
  }, [speechSupported, stopSpeaking]);

  useEffect(() => {
    startTranscriptionRef.current = startTranscription;
  }, [startTranscription]);

  const advanceToQuestion = useCallback(
    async (index: number) => {
      const nextItem = plan[index];
      if (!nextItem) {
        setStatus("idle");
        return;
      }
      setCurrentIndex(index);
      // Stop listening before TTS to prevent microphone picking up speaker audio
      stopTranscription();
      const updatedConversation: Message[] = [
        ...conversationRef.current,
        { role: "interviewer", content: nextItem.interviewerQuestion },
      ];
      updateConversation(updatedConversation);
      // speak() now resolves when audio playback finishes
      await speak(nextItem.interviewerQuestion);
      // Only start recognition after audio ends and if not paused/idle
      if (statusRef.current !== "paused" && statusRef.current !== "idle") {
        startTranscriptionRef.current();
      }
    },
    [plan, speak, stopTranscription, updateConversation]
  );

  const startInterview = useCallback(async () => {
    setApiError(null);
    setFinalSummary("");
    setFeedback(null);
    setSeedCount(null);
    setSpeechError(null);
    currentUserTurnRef.current = "";
    updateConversation([]);
    setPlan([]);
    setCurrentIndex(0);

    setStatus("speaking_intro");
    try {
      const res = await fetch("/api/mock-interview/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firm: settings.firm,
          stage: settings.stage,
          questionTypes: settings.questionTypes,
          numQuestions,
          randomize: settings.randomize,
          interviewMode,
        }),
      });
      const text = await res.text();
      const payload = parseJsonRecord(text);

      if (!res.ok) {
        const msg = (payload.error as string) || res.statusText;
        const requestId = payload.requestId as string | undefined;
        const fullMessage =
          res.status === 404
            ? `No questions found for ${settings.firm} ${settings.stage.replace(
                /_/g,
                " "
              )}. Add questions to the bank or adjust filters.`
            : msg;
        setApiError(requestId ? `${fullMessage} (Request ID: ${requestId})` : fullMessage);
        setStatus("idle");
        return;
      }

      const response = payload as PlanResponse;
      if (!response.plan || response.plan.length === 0) {
        setApiError("No plan generated. Adjust filters and try again.");
        setStatus("idle");
        return;
      }
      setPlan(response.plan);
      setSeedCount(response.seedCount);
      setCurrentIndex(0);
      const firstQuestion = response.plan[0];
      updateConversation([{ role: "interviewer", content: firstQuestion.interviewerQuestion }]);
      // speak waits until audio finishes, then start listening
      await speak(firstQuestion.interviewerQuestion);
      if (statusRef.current !== "paused" && statusRef.current !== "idle") {
        startTranscriptionRef.current();
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to start interview.");
      setStatus("idle");
    }
  }, [interviewMode, numQuestions, settings, speak, updateConversation]);

  const finalizeTurn = useCallback(async () => {
    if (inFlightRef.current) return;
    const lastUserTurn = currentUserTurnRef.current.trim();
    if (!lastUserTurn) return;
    currentUserTurnRef.current = "";

    // Stop recognition while processing to avoid stale audio capture
    stopTranscription();

    const updatedConversation: Message[] = [
      ...conversationRef.current,
      { role: "user", content: lastUserTurn },
    ];
    updateConversation(updatedConversation);

    const currentItem = plan[currentIndex];
    if (!currentItem) return;
    setStatus("thinking");
    inFlightRef.current = true;

    try {
      const res = await fetch("/api/mock-interview/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planItem: currentItem,
          userAnswer: lastUserTurn,
          firm: settings.firm,
          stage: settings.stage,
          interviewMode,
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

      const response = payload as GradeResponse;
      setFeedback(response);

      const nextIndex = currentIndex + 1;
      if (nextIndex >= plan.length) {
        setStatus("idle");
        return;
      }
      if (statusRef.current === "paused") {
        setPendingNext(true);
        return;
      }
      await advanceToQuestion(nextIndex);
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to process turn.");
      setStatus("idle");
    } finally {
      inFlightRef.current = false;
    }
  }, [advanceToQuestion, currentIndex, interviewMode, plan, settings, stopTranscription, updateConversation]);

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
    if (pendingNext) {
      setPendingNext(false);
      void advanceToQuestion(currentIndex + 1);
      return;
    }
    startTranscriptionRef.current();
  }, [advanceToQuestion, currentIndex, pendingNext, status]);

  const endInterview = useCallback(async () => {
    stopTranscription();
    stopSpeaking();

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
    setPlan([]);
    setCurrentIndex(0);
    setPendingNext(false);
    try {
      const res = await fetch("/api/mock-interview/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings,
          interviewMode,
          askedQuestionIds: plan.map((item) => String(item.qIndex)),
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

      const response = payload as { finalSummary?: string };
      setFinalSummary(response.finalSummary || "");
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to end interview.");
    }
  }, [interviewMode, plan, settings, stopSpeaking, stopTranscription, updateConversation]);

  const handleHoldStart = () => {
    if (!holdToTalk) return;
    startTranscriptionRef.current();
  };

  const handleHoldEnd = () => {
    if (!holdToTalk) return;
    stopTranscription();
  };

  const statusStyles: Record<InterviewStatus, { dot: string; pulse: boolean; badgeTone: "neutral" | "success" | "warning" }> = {
    idle: { dot: "bg-slate-300", pulse: false, badgeTone: "neutral" },
    speaking_intro: { dot: "bg-amber-400", pulse: true, badgeTone: "warning" },
    listening: { dot: "bg-emerald-400", pulse: true, badgeTone: "success" },
    thinking: { dot: "bg-blue-400", pulse: true, badgeTone: "neutral" },
    speaking: { dot: "bg-amber-400", pulse: true, badgeTone: "warning" },
    paused: { dot: "bg-slate-300", pulse: false, badgeTone: "neutral" },
  };

  const currentStatusStyle = statusStyles[status];

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
                  label="Interview mode"
                  value={interviewMode}
                  options={interviewModeOptions.map((o) => ({ value: o.value, label: o.label }))}
                  onChange={(value) => setInterviewMode(value as InterviewMode)}
                  className="md:col-span-2"
                />
                {modeConfig.description ? (
                  <div className="md:col-span-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                    {modeConfig.description}
                    {modeConfig.pressureLevel !== "low" ? (
                      <span className="ml-2 font-semibold">
                        Pressure: {modeConfig.pressureLevel}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <Select
                  label="Firm"
                  value={settings.firm}
                  options={firmOptions}
                  onChange={(value) =>
                    setSettings((prev: MockInterviewSettings) => ({ ...prev, firm: value }))
                  }
                />
                <Select
                  label="Stage"
                  value={settings.stage}
                  options={stageOptions}
                  onChange={(value) =>
                    setSettings((prev: MockInterviewSettings) => ({
                      ...prev,
                      stage: value as MockInterviewSettings["stage"],
                    }))
                  }
                />
                <Select
                  label="Number of questions"
                  value={String(numQuestions)}
                  options={[
                    { value: "4", label: "4" },
                    { value: "6", label: "6" },
                    { value: "8", label: "8" },
                    { value: "10", label: "10" },
                    { value: "12", label: "12" },
                  ]}
                  onChange={(value) => setNumQuestions(Number.parseInt(value, 10))}
                />
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="text-sm font-semibold text-slate-900">Question types</div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-700">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={allTypesSelected}
                        onChange={(event) => toggleAllTypes(event.target.checked)}
                      />
                      <span>All</span>
                    </label>
                    {questionTypeOptions.map((type) => (
                      <label key={type} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={
                            allTypesSelected || settings.questionTypes.includes(type)
                          }
                          onChange={(event) => toggleType(type, event.target.checked)}
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
                    checked={showOtherFirms}
                    onChange={(event) => setShowOtherFirms(event.target.checked)}
                  />
                  <span>Show Other/Unclassified</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.randomize}
                    onChange={(event) =>
                      setSettings((prev: MockInterviewSettings) => ({
                        ...prev,
                        randomize: event.target.checked,
                      }))
                    }
                  />
                  <span>Randomize questions</span>
                </label>
                <div className="text-xs text-slate-500">
                  Randomize: pick the next question at random from your selected filters.
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={settings.followUps}
                    onChange={(event) =>
                      setSettings((prev: MockInterviewSettings) => ({
                        ...prev,
                        followUps: event.target.checked,
                      }))
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
                  <div className="mt-1 text-lg font-semibold text-slate-900">Live Interview</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    {currentStatusStyle.pulse && (
                      <span
                        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${currentStatusStyle.dot}`}
                      />
                    )}
                    <span
                      className={`relative inline-flex h-3 w-3 rounded-full ${currentStatusStyle.dot}`}
                    />
                  </span>
                  <Badge tone={currentStatusStyle.badgeTone}>
                    {status === "idle" ? "Ready" : status === "speaking_intro" ? "Speaking" : status.charAt(0).toUpperCase() + status.slice(1)}
                  </Badge>
                </div>
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
                {pendingNext && status === "paused" ? (
                  <Button variant="secondary" onClick={resumeInterview} type="button">
                    Next
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={endInterview} type="button">
                  End Interview
                </Button>
              </div>

              <div className="mt-4 flex items-center gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={holdToTalk}
                  onChange={(e) => setHoldToTalk(e.target.checked)}
                />
                <span>Hold to talk</span>
                {holdToTalk ? (
                  <Button
                    variant="secondary"
                    type="button"
                    onMouseDown={handleHoldStart}
                    onMouseUp={handleHoldEnd}
                    onMouseLeave={handleHoldEnd}
                    onTouchStart={handleHoldStart}
                    onTouchEnd={handleHoldEnd}
                  >
                    Hold to Talk
                  </Button>
                ) : null}
              </div>

              {status === "listening" && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-4 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"
                >
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-sm font-semibold text-emerald-800">Your turn — speak now</span>
                </motion.div>
              )}
              {(status === "speaking" || status === "speaking_intro") && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
                >
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
                  </span>
                  <span className="text-sm font-semibold text-amber-800">Interviewer is speaking...</span>
                </motion.div>
              )}
              {status === "thinking" && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-4 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3"
                >
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-blue-500" />
                  </span>
                  <span className="text-sm font-semibold text-blue-800">Grading your answer...</span>
                </motion.div>
              )}

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
                  Speech recognition not supported — use Chrome or enable fallback.
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
              {seedCount !== null ? (
                <div className="mt-3 text-xs text-slate-500">
                  Seed questions loaded: {seedCount}
                </div>
              ) : null}
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">Conversation</div>
                {plan.length > 0 ? (
                  <Badge tone="neutral">
                    Q{currentIndex + 1} of {plan.length}
                  </Badge>
                ) : null}
              </div>
              {plan.length > 0 && (
                <div className="mt-3 flex gap-1">
                  {plan.map((_, i) => (
                    <div
                      key={i}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        i < currentIndex
                          ? "bg-emerald-400"
                          : i === currentIndex
                            ? "bg-slate-900"
                            : "bg-slate-200"
                      }`}
                    />
                  ))}
                </div>
              )}
              {plan[currentIndex] ? (
                <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">Current question:</span>{" "}
                  {plan[currentIndex].interviewerQuestion}
                </div>
              ) : null}
              <div className="mt-4 space-y-3">
                {conversation.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">
                    Configure your settings and start the interview.
                  </div>
                ) : (
                  conversation.map((msg, idx) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                          msg.role === "user"
                            ? "bg-slate-900 text-white"
                            : "border border-slate-200 bg-slate-50 text-slate-900"
                        }`}
                      >
                        {msg.content}
                      </div>
                    </motion.div>
                  ))
                )}
                {interimTranscript ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-400">
                      {interimTranscript}
                    </div>
                  </div>
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
                <div className="text-base font-semibold text-slate-900">Interview Feedback</div>
                <Badge tone="neutral">Auto-graded</Badge>
              </div>
              {feedback ? (
                <div className="mt-4 space-y-4 text-sm text-slate-700">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full text-lg font-bold text-white ${
                        feedback.score0to10 >= 7
                          ? "bg-emerald-500"
                          : feedback.score0to10 >= 4
                            ? "bg-amber-500"
                            : "bg-red-500"
                      }`}
                    >
                      {feedback.score0to10}
                    </div>
                    <div className="flex-1">
                      <div className="font-semibold text-slate-900">Score: {feedback.score0to10}/10</div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200">
                        <div
                          className={`h-1.5 rounded-full transition-all ${
                            feedback.score0to10 >= 7
                              ? "bg-emerald-400"
                              : feedback.score0to10 >= 4
                                ? "bg-amber-400"
                                : "bg-red-400"
                          }`}
                          style={{ width: `${feedback.score0to10 * 10}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">Strengths</div>
                    <ul className="mt-2 space-y-1.5">
                      {feedback.strengths.map((item, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">Gaps</div>
                    <ul className="mt-2 space-y-1.5">
                      {feedback.gaps.map((item, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <div className="font-semibold text-slate-900">Better outline</div>
                    <div className="mt-2 whitespace-pre-wrap text-xs">{feedback.correctedAnswerOutline}</div>
                  </div>
                  <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Next best sentence</div>
                    <div className="mt-1 text-sm font-medium text-emerald-900">{feedback.nextBestSentence}</div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 py-6 text-center text-sm text-slate-400">
                  Feedback updates after each response.
                </div>
              )}
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
                {finalSummary || (
                  <span className="block py-6 text-center text-slate-400">End the interview to see your summary.</span>
                )}
              </div>
              {finalSummary ? (
                <Button
                  variant="secondary"
                  type="button"
                  className="mt-4"
                  onClick={() => void speak(finalSummary)}
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
