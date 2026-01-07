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

  const advanceToQuestion = useCallback(
    async (index: number) => {
      const nextItem = plan[index];
      if (!nextItem) {
        setStatus("idle");
        return;
      }
      setCurrentIndex(index);
      const updatedConversation: Message[] = [
        ...conversationRef.current,
        { role: "interviewer", content: nextItem.interviewerQuestion },
      ];
      updateConversation(updatedConversation);
      await speak(nextItem.interviewerQuestion);
      startTranscriptionRef.current();
    },
    [plan, speak, updateConversation]
  );

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
      await speak(firstQuestion.interviewerQuestion);
      startTranscriptionRef.current();
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to start interview.");
      setStatus("idle");
    }
  }, [numQuestions, settings, speak, updateConversation]);

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
      if (status === "paused") {
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
  }, [advanceToQuestion, currentIndex, plan, settings, status, updateConversation]);

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
    setPlan([]);
    setCurrentIndex(0);
    setPendingNext(false);
    try {
      const res = await fetch("/api/mock-interview/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings,
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
  }, [plan, settings, stopSpeaking, stopTranscription, updateConversation]);

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
                {pendingNext && status === "paused" ? (
                  <Button variant="secondary" onClick={resumeInterview} type="button">
                    Next
                  </Button>
                ) : null}
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
              {plan[currentIndex] ? (
                <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">Current question:</span>{" "}
                  {plan[currentIndex].interviewerQuestion}
                </div>
              ) : null}
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
                <div className="text-base font-semibold text-slate-900">Interview Feedback</div>
                <Badge tone="neutral">Auto-graded</Badge>
              </div>
              {feedback ? (
                <div className="mt-4 space-y-3 text-sm text-slate-700">
                  <div className="font-semibold text-slate-900">Score: {feedback.score0to10}/10</div>
                  <div>
                    <div className="font-semibold text-slate-900">Strengths</div>
                    <ul className="mt-2 space-y-1">
                      {feedback.strengths.map((item, idx) => (
                        <li key={idx}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">Gaps</div>
                    <ul className="mt-2 space-y-1">
                      {feedback.gaps.map((item, idx) => (
                        <li key={idx}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">Better outline</div>
                    <div className="mt-2 whitespace-pre-wrap">{feedback.correctedAnswerOutline}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">Next best sentence</div>
                    <div className="mt-2">{feedback.nextBestSentence}</div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 whitespace-pre-wrap text-sm text-slate-700">
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
