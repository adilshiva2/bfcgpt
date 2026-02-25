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

type Phase = "opening" | "user_intro" | "exploration" | "fit" | "user_questions" | "close";

type ScenarioPayload = {
  track: string;
  firmType: string;
  group: string;
  interviewerVibe: string;
  difficulty: string;
  goal: "referral";
  persona: {
    name: string;
    title: string;
    firm: string;
    group: string;
  };
  phase: Phase;
};

type Message = {
  role: "user" | "interviewer";
  content: string;
};

type LiveCoach = {
  tone: string;
  clarity: string;
  structure: string;
  referral: string;
  bullets: string[];
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

const PERSONAS = [
  { name: "Jordan", title: "Analyst" },
  { name: "Avery", title: "Associate" },
  { name: "Morgan", title: "VP" },
  { name: "Riley", title: "Associate" },
  { name: "Casey", title: "Analyst" },
  { name: "Taylor", title: "VP" },
];

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
  const inFlightRef = useRef(false);
  const lastSubmittedTurnHashRef = useRef<string | null>(null);
  const hasUserSpokenRef = useRef(false);
  const introTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInterviewerTextRef = useRef("");
  const turnIndexRef = useRef(0);
  const interviewStateRef = useRef<InterviewState>("idle");
  const startTranscriptionRef = useRef<() => void>(() => {});
  const pausedRef = useRef(false);
  const holdToTalkRef = useRef(false);
  const isTranscribingRef = useRef(false);

  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [difficulty, setDifficulty] = useState<Difficulty>("Standard");
  const [phase, setPhase] = useState<Phase>("opening");
  const [messages, setMessages] = useState<Message[]>([]);
  const [userTurns, setUserTurns] = useState(0);
  const [turnIndex, setTurnIndex] = useState(0);

  const [interviewState, setInterviewState] = useState<InterviewState>("idle");
  const [interviewError, setInterviewError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [holdToTalk, setHoldToTalk] = useState(false);

  const [speechSupported, setSpeechSupported] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptInterim, setTranscriptInterim] = useState("");
  const [speechError, setSpeechError] = useState<string | null>(null);

  const [audioNeedsClick, setAudioNeedsClick] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<number | null>(null);
  const [ttsContentType, setTtsContentType] = useState<string>("-");
  const [ttsBytes, setTtsBytes] = useState<number | null>(null);

  const [liveCoach, setLiveCoach] = useState<LiveCoach | null>(null);
  const [liveCoachError, setLiveCoachError] = useState<string | null>(null);
  const [turnReview, setTurnReview] = useState<string>("");
  const [finalSummary, setFinalSummary] = useState<string>("");

  const debugTts = process.env.NEXT_PUBLIC_DEBUG_TTS === "true";
  const debugEnabled = process.env.NEXT_PUBLIC_DEBUG_INTERVIEW === "true";
  const [showDebug, setShowDebug] = useState(false);

  const lastLiveCoachAtRef = useRef(0);
  const liveCoachTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveCoachRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLiveCoachTextRef = useRef("");

  const firmTypeOptions = useMemo(
    () => firmTypesByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const groupOptions = useMemo(
    () => groupsByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const vibeOptions = useMemo(() => vibes.map((value) => ({ value, label: value })), []);

  const persona = useMemo(() => {
    const idx = Math.max(0, roleTracks.indexOf(scenario.track));
    const base = PERSONAS[idx % PERSONAS.length];
    return {
      name: base.name,
      title: base.title,
      firm: scenario.firmType,
      group: scenario.group,
    };
  }, [scenario]);

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
      if (introTimeoutRef.current) {
        clearTimeout(introTimeoutRef.current);
      }
      if (liveCoachTimeoutRef.current) {
        clearTimeout(liveCoachTimeoutRef.current);
      }
      if (liveCoachRetryRef.current) {
        clearTimeout(liveCoachRetryRef.current);
      }
    };
  }, []);

  useEffect(() => {
    interviewStateRef.current = interviewState;
  }, [interviewState]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    holdToTalkRef.current = holdToTalk;
  }, [holdToTalk]);

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
            setInterviewState("speaking");
            try {
              await audioEl.play();
              setAudioNeedsClick(false);
            } catch {
              setAudioNeedsClick(true);
              setInterviewState("listening");
              resolve();
              return;
            }
            audioEl.onended = () => {
              URL.revokeObjectURL(audioUrl);
              setInterviewState("listening");
              resolve();
            };
            audioEl.onerror = () => {
              setInterviewState("listening");
              resolve();
            };
          } catch (err) {
            setTtsError(err instanceof Error ? err.message : "TTS failed.");
            setInterviewState("listening");
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

  const stopTranscription = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    isTranscribingRef.current = false;
    setIsTranscribing(false);
    setTranscriptInterim("");
  }, []);

  const scenarioPayload: ScenarioPayload = useMemo(
    () => ({
      track: scenario.track,
      firmType: scenario.firmType,
      group: scenario.group,
      interviewerVibe: scenario.person.vibe,
      difficulty,
      goal: "referral",
      persona,
      phase,
    }),
    [scenario, difficulty, persona, phase]
  );

  const callInterviewer = useCallback(
    async (nextMessages: Message[]) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setInterviewState("thinking");
      setInterviewError(null);
      try {
        const res = await fetch("/api/interviewer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages,
            scenario: scenarioPayload,
            turnIndex: turnIndexRef.current,
            lastInterviewerText: lastInterviewerTextRef.current,
          }),
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
        lastInterviewerTextRef.current = interviewerText;
        // Stop listening before TTS to prevent mic picking up speaker audio
        stopTranscription();
        // speak() now resolves when audio playback finishes
        await speak(interviewerText);
        // Only start recognition after audio ends and if not paused/idle
        if (interviewStateRef.current !== "idle" && !pausedRef.current) {
          startTranscriptionRef.current();
        }
      } catch (err) {
        setInterviewError(err instanceof Error ? err.message : "Interview request failed.");
        setInterviewState("error");
      } finally {
        inFlightRef.current = false;
      }
    },
    [scenarioPayload, speak, stopTranscription]
  );

  const callLiveCoach = useCallback(
    async (lastUserTurn: string) => {
      if (!lastUserTurn.trim()) return;
      try {
        const res = await fetch("/api/coach/live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastUserTurn, scenario: scenarioPayload, phase }),
        });
        const text = await res.text();
        let payload: Record<string, unknown> = {};
        try {
          payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          payload = {};
        }

        if (res.status === 429) {
          const retryAfterSeconds = Number(payload.retryAfterSeconds) || 2;
          setLiveCoachError(
            `Live coaching is paused for ${retryAfterSeconds}s due to rate limits.`
          );
          if (!liveCoachRetryRef.current) {
            liveCoachRetryRef.current = setTimeout(() => {
              liveCoachRetryRef.current = null;
              if (lastLiveCoachTextRef.current) {
                void callLiveCoach(lastLiveCoachTextRef.current);
              }
            }, retryAfterSeconds * 1000);
          }
          return;
        }

        if (res.ok) {
          setLiveCoachError(null);
          const parsed = payload as LiveCoach;
          if (parsed?.tone && parsed?.clarity && parsed?.structure && parsed?.referral) {
            setLiveCoach(parsed);
          }
        }
      } catch {
        // Ignore live coach failures to avoid blocking
      }
    },
    [phase, scenarioPayload]
  );

  const queueLiveCoach = useCallback(
    (lastUserTurn: string) => {
      if (!lastUserTurn.trim()) return;
      lastLiveCoachTextRef.current = lastUserTurn;
      const now = Date.now();
      const elapsed = now - lastLiveCoachAtRef.current;
      if (elapsed >= 2000) {
        lastLiveCoachAtRef.current = now;
        void callLiveCoach(lastUserTurn);
        return;
      }

      if (liveCoachTimeoutRef.current) {
        clearTimeout(liveCoachTimeoutRef.current);
      }
      liveCoachTimeoutRef.current = setTimeout(() => {
        lastLiveCoachAtRef.current = Date.now();
        void callLiveCoach(lastLiveCoachTextRef.current);
      }, 2000 - elapsed);
    },
    [callLiveCoach]
  );

  const callTurnCoach = useCallback(
    async (lastUserTurn: string) => {
      if (!lastUserTurn.trim()) return;
      try {
        const res = await fetch("/api/coach/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastUserTurn, scenario: scenarioPayload, phase }),
        });
        const text = await res.text();
        const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (res.ok && payload.turnReview) {
          setTurnReview(payload.turnReview as string);
        }
      } catch {
        // Non-blocking
      }
    },
    [phase, scenarioPayload]
  );

  const callFinalCoach = useCallback(
    async () => {
      try {
        const res = await fetch("/api/coach/final", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, scenario: scenarioPayload }),
        });
        const text = await res.text();
        const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (res.ok && payload.finalSummary) {
          setFinalSummary(payload.finalSummary as string);
        }
      } catch {
        // Non-blocking
      }
    },
    [messages, scenarioPayload]
  );

  const buildFeedback = useCallback((text: string) => {
    const lower = text.toLowerCase();
    const fillerWords = ["um", "uh", "like", "you know", "sort of", "kind of"];
    const fillerCount = fillerWords.reduce((sum, word) => sum + (lower.split(word).length - 1), 0);
    const longAnswer = text.length > 600;
    const entitlement = /(i deserve|i should|get me|give me)/i.test(text);
    const questions = (text.match(/\?/g) || []).length;

    const strengths = [
      "Clear intent to learn about the role.",
      questions > 0 ? "Asked at least one thoughtful question." : "Engaged tone with relevant detail.",
    ];
    const fixes = [
      longAnswer ? "Shorten responses to 20–30 seconds to stay crisp." : "Add a concrete example to increase credibility.",
      fillerCount > 2 ? "Reduce filler words to sound more confident." : "Ask a sharper follow-up after your answer.",
    ];

    const nextQuestion = "What does success look like in this group for a new analyst?";
    const referralAsk = entitlement
      ? "If it feels appropriate after a few chats, would you be open to a referral once I’ve learned more about the team?"
      : "If it makes sense after I learn more, would you be open to a referral down the line?";

    return [
      "Strengths:",
      `- ${strengths[0]}`,
      `- ${strengths[1]}`,
      "",
      "Fixes:",
      `- ${fixes[0]}`,
      `- ${fixes[1]}`,
      "",
      "Better next question:",
      `- ${nextQuestion}`,
      "",
      "Referral ask line:",
      `- ${referralAsk}`,
    ].join("\n");
  }, []);

  const normalizeTurn = useCallback((text: string) => text.replace(/\s+/g, " ").trim(), []);

  const hashTurn = useCallback((text: string) => {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return `${hash}`;
  }, []);

  const finalizeTurn = useCallback(async () => {
    const normalized = normalizeTurn(currentUserTurnRef.current);
    if (!normalized) return;
    const turnHash = hashTurn(normalized);
    if (turnHash === lastSubmittedTurnHashRef.current || inFlightRef.current) {
      return;
    }
    lastSubmittedTurnHashRef.current = turnHash;
    currentUserTurnRef.current = "";
    const userMessage: Message = { role: "user", content: normalized };
    const nextMessages: Message[] = [...messages, userMessage];
    setMessages(nextMessages);
    setTurnReview(buildFeedback(normalized));
    void callTurnCoach(normalized);
    turnIndexRef.current += 1;
    setTurnIndex(turnIndexRef.current);
    await callInterviewer(nextMessages);

    if (phase === "opening") setPhase("user_intro");
    else if (phase === "user_intro") setPhase("exploration");
    else if (phase === "exploration" && userTurns >= 1) setPhase("fit");
    else if (phase === "fit" && userTurns >= 2) setPhase("user_questions");
    else if (phase === "user_questions" && userTurns >= 3) setPhase("close");

    setUserTurns((prev) => prev + 1);
  }, [
    buildFeedback,
    callInterviewer,
    callTurnCoach,
    hashTurn,
    messages,
    normalizeTurn,
    phase,
    userTurns,
  ]);

  const startTranscription = useCallback(() => {
    setSpeechError(null);
    if (!speechSupported) {
      setSpeechError("Speech recognition not supported—use Chrome or enable fallback.");
      return;
    }
    if (isTranscribingRef.current) return;

    const recognition = getSpeechRecognition();
    if (!recognition) {
      setSpeechError("Speech recognition not supported—use Chrome or enable fallback.");
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
        if (chunk.trim()) {
          hasUserSpokenRef.current = true;
        }
        if (result.isFinal) {
          finalText += chunk;
        } else {
          interimText += chunk;
        }
      }

      // Use ref to avoid stale closure — state may be outdated
      if (interviewStateRef.current === "speaking") {
        stopSpeaking();
        setInterviewState("listening");
      }

      const trimmedFinal = finalText.trim();
      if (trimmedFinal) {
        currentUserTurnRef.current = `${currentUserTurnRef.current} ${trimmedFinal}`.trim();
        queueLiveCoach(trimmedFinal);
        if (!holdToTalkRef.current) {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
          }
          silenceTimerRef.current = setTimeout(() => {
            void finalizeTurn();
          }, 900);
        }
      }
      setTranscriptInterim(interimText.trim());
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
      setTranscriptInterim("");
      if (holdToTalkRef.current && currentUserTurnRef.current.trim()) {
        void finalizeTurn();
      } else if (
        !holdToTalkRef.current &&
        interviewStateRef.current === "listening" &&
        !pausedRef.current
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
    setInterviewState("listening");
  }, [finalizeTurn, queueLiveCoach, speechSupported, stopSpeaking]);

  useEffect(() => {
    startTranscriptionRef.current = startTranscription;
  }, [startTranscription]);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(scenario.track);
    setScenario(sc);
  }, [scenario.track]);

  const startInterview = useCallback(async () => {
    setMessages([]);
    setUserTurns(0);
    setTurnIndex(0);
    turnIndexRef.current = 0;
    lastSubmittedTurnHashRef.current = null;
    lastInterviewerTextRef.current = "";
    hasUserSpokenRef.current = false;
    currentUserTurnRef.current = "";
    setInterviewError(null);
    setTranscriptInterim("");
    setFinalSummary("");
    setTurnReview("");
    setPhase("opening");
    if (!holdToTalk) {
      startTranscription();
    }
    if (introTimeoutRef.current) {
      clearTimeout(introTimeoutRef.current);
    }
    introTimeoutRef.current = setTimeout(() => {
      if (!hasUserSpokenRef.current) {
        void callInterviewer([{ role: "user", content: "Begin the coffee chat." }]);
      }
    }, 300);
  }, [callInterviewer, holdToTalk, startTranscription]);

  const endInterview = useCallback(async () => {
    if (introTimeoutRef.current) {
      clearTimeout(introTimeoutRef.current);
    }
    stopTranscription();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }
    if (currentUserTurnRef.current.trim()) {
      await finalizeTurn();
    }
    stopSpeaking();
    currentUserTurnRef.current = "";
    setInterviewState("idle");
    setInterviewError(null);
    await callFinalCoach();
  }, [callFinalCoach, finalizeTurn, stopSpeaking, stopTranscription]);

  const pauseInterview = useCallback(() => {
    if (introTimeoutRef.current) {
      clearTimeout(introTimeoutRef.current);
    }
    setPaused(true);
    stopTranscription();
    stopSpeaking();
  }, [stopSpeaking, stopTranscription]);

  const resumeInterview = useCallback(() => {
    setPaused(false);
    if (!holdToTalk) {
      startTranscription();
    }
  }, [holdToTalk, startTranscription]);

  const handleHoldStart = () => {
    if (!holdToTalk) return;
    startTranscription();
  };

  const handleHoldEnd = () => {
    if (!holdToTalk) return;
    stopTranscription();
  };

  const phaseList: { key: Phase; label: string }[] = [
    { key: "opening", label: "Opening" },
    { key: "user_intro", label: "Intro" },
    { key: "exploration", label: "Explore" },
    { key: "fit", label: "Fit" },
    { key: "user_questions", label: "Q&A" },
    { key: "close", label: "Close" },
  ];

  const activePhaseIndex = phaseList.findIndex((p) => p.key === phase);

  const stateStyles: Record<InterviewState, { dot: string; pulse: boolean; badgeTone: "neutral" | "success" | "warning" }> = {
    idle: { dot: "bg-slate-300", pulse: false, badgeTone: "neutral" },
    listening: { dot: "bg-emerald-400", pulse: true, badgeTone: "success" },
    thinking: { dot: "bg-blue-400", pulse: true, badgeTone: "neutral" },
    speaking: { dot: "bg-amber-400", pulse: true, badgeTone: "warning" },
    error: { dot: "bg-red-400", pulse: false, badgeTone: "neutral" },
  };

  const currentStateStyle = stateStyles[paused ? "idle" : interviewState];

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-16 pt-10">
      {interviewState !== "idle" && (
        <div className="mb-6 flex items-center gap-1 overflow-x-auto">
          {phaseList.map((p, i) => (
            <React.Fragment key={p.key}>
              <div
                className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                  i === activePhaseIndex
                    ? "bg-slate-900 text-white shadow-sm"
                    : i < activePhaseIndex
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-400"
                }`}
              >
                {p.label}
              </div>
              {i < phaseList.length - 1 && (
                <div
                  className={`h-px w-4 flex-shrink-0 ${
                    i < activePhaseIndex ? "bg-emerald-300" : "bg-slate-200"
                  }`}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      )}
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
                    Coffee Chat
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    {currentStateStyle.pulse && (
                      <span
                        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${currentStateStyle.dot}`}
                      />
                    )}
                    <span
                      className={`relative inline-flex h-3 w-3 rounded-full ${currentStateStyle.dot}`}
                    />
                  </span>
                  <Badge tone={currentStateStyle.badgeTone}>
                    {paused ? "Paused" : interviewState === "idle" ? "Ready" : interviewState.charAt(0).toUpperCase() + interviewState.slice(1)}
                  </Badge>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button onClick={startInterview} type="button">
                  Start Interview
                </Button>
                <Button variant="secondary" onClick={endInterview} type="button">
                  End Interview
                </Button>
                <Button
                  variant="secondary"
                  onClick={paused ? resumeInterview : pauseInterview}
                  type="button"
                >
                  {paused ? "Resume" : "Pause"}
                </Button>
                {debugEnabled ? (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setShowDebug((prev) => !prev)}
                    className="px-2 py-1 text-xs"
                  >
                    {showDebug ? "Hide Debug" : "Show Debug"}
                  </Button>
                ) : null}
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

              {interviewState === "listening" && !paused && (
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
              {interviewState === "speaking" && (
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
              {interviewState === "thinking" && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-4 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3"
                >
                  <span className="relative flex h-3 w-3">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-blue-500" />
                  </span>
                  <span className="text-sm font-semibold text-blue-800">Processing your response...</span>
                </motion.div>
              )}

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
              <div className="mt-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-400">
                    Start the interview to begin your coffee chat.
                  </div>
                ) : (
                  messages.map((msg, idx) => (
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
                {transcriptInterim ? (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-400">
                      {transcriptInterim}
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
                <div className="text-base font-semibold text-slate-900">Live coaching</div>
                <Badge tone="neutral">Realtime</Badge>
              </div>
              <div className="mt-4 space-y-3 text-sm text-slate-700">
                {liveCoachError ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                    {liveCoachError}
                  </div>
                ) : null}
                {liveCoach ? (
                  <div className="space-y-3">
                    {[
                      { label: "Rapport", value: liveCoach.tone },
                      { label: "Clarity", value: liveCoach.clarity },
                      { label: "Structure", value: liveCoach.structure },
                      { label: "Referral", value: liveCoach.referral },
                    ].map((metric) => (
                      <div key={metric.label} className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{metric.label}</span>
                        <Badge
                          tone={
                            metric.value === "warm" || metric.value === "clear" || metric.value === "has story" || metric.value === "ready"
                              ? "success"
                              : metric.value === "abrupt" || metric.value === "rambling" || metric.value === "too early"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {metric.value}
                        </Badge>
                      </div>
                    ))}
                    <div className="space-y-1.5 border-t border-slate-100 pt-3">
                      {liveCoach.bullets.map((bullet, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs text-slate-600">
                          <span className="mt-0.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
                          {bullet}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="py-4 text-center text-sm text-slate-400">
                    Live coaching updates after each response.
                  </div>
                )}
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
                <div className="text-base font-semibold text-slate-900">Turn review</div>
                <Badge tone="neutral">After each answer</Badge>
              </div>
              <div className="mt-4 min-h-[160px] whitespace-pre-wrap text-sm text-slate-800">
                {turnReview || (
                  <span className="block py-4 text-center text-slate-400">Turn review appears after each answer.</span>
                )}
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
                <div className="text-base font-semibold text-slate-900">Final summary</div>
                <Badge tone="neutral">End of call</Badge>
              </div>
              <div className="mt-4 min-h-[200px] whitespace-pre-wrap text-sm text-slate-800">
                {finalSummary || (
                  <span className="block py-6 text-center text-slate-400">Final summary appears after ending the interview.</span>
                )}
              </div>
              {debugEnabled && showDebug ? (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Debug</div>
                  <div className="mt-2 space-y-1">
                    <div>State: {interviewState}</div>
                    <div>Phase: {phase}</div>
                    <div>Turn index: {turnIndex}</div>
                    <div>Paused: {paused ? "yes" : "no"}</div>
                    <div>Hold to talk: {holdToTalk ? "yes" : "no"}</div>
                    <div>Transcribing: {isTranscribing ? "yes" : "no"}</div>
                    <div>Messages: {messages.length}</div>
                  </div>
                </div>
              ) : null}
              {debugTts && debugEnabled && showDebug ? (
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
