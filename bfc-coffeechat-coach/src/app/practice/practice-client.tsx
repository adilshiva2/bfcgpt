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

type CallState =
  | "idle"
  | "requesting_mic"
  | "creating_peer"
  | "posting_sdp"
  | "setting_remote"
  | "connected"
  | "live"
  | "error";

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

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export default function PracticeClient() {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const callStateRef = useRef<CallState>("idle");
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [difficulty, setDifficulty] = useState<Difficulty>("Standard");

  const [callState, setCallState] = useState<CallState>("idle");
  const [lastStep, setLastStep] = useState<string>("idle");
  const [lastStepAt, setLastStepAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<"unknown" | "granted" | "denied">("unknown");
  const [audioNeedsClick, setAudioNeedsClick] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [endpointStatus, setEndpointStatus] = useState<number | null>(null);

  const [pcConnectionState, setPcConnectionState] = useState("new");
  const [pcIceState, setPcIceState] = useState("new");
  const [pcSignalingState, setPcSignalingState] = useState("stable");
  const [dcState, setDcState] = useState("closed");
  const [remoteAudioReceived, setRemoteAudioReceived] = useState(false);
  const [remoteStreamCount, setRemoteStreamCount] = useState(0);
  const [localTrackCount, setLocalTrackCount] = useState(0);

  const [userTranscript, setUserTranscript] = useState("");
  const [userLive, setUserLive] = useState("");
  const [aiTranscript, setAiTranscript] = useState("");
  const [aiLive, setAiLive] = useState("");

  const debugRealtime = process.env.NEXT_PUBLIC_DEBUG_REALTIME === "true";

  const firmTypeOptions = useMemo(
    () => firmTypesByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const groupOptions = useMemo(
    () => groupsByTrack[scenario.track].map((value) => ({ value, label: value })),
    [scenario.track]
  );
  const vibeOptions = useMemo(() => vibes.map((value) => ({ value, label: value })), []);

  const pushEvent = useCallback((entry: string) => {
    setEventLog((prev) => [entry, ...prev].slice(0, 30));
  }, []);

  const setState = useCallback(
    (state: CallState) => {
      setCallState(state);
      callStateRef.current = state;
      setLastStep(state);
      setLastStepAt(new Date().toLocaleTimeString());
      if (debugRealtime) {
        console.log(`[realtime] state -> ${state}`);
      }
    },
    [debugRealtime]
  );

  const ensureAudioElement = useCallback(() => {
    if (!audioElementRef.current) {
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.setAttribute("playsinline", "");
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioElementRef.current = audioEl;
    }
    return audioElementRef.current;
  }, []);

  const attemptPlay = useCallback(async () => {
    const audioEl = audioElementRef.current;
    if (!audioEl) return;
    try {
      await audioEl.play();
      setAudioNeedsClick(false);
    } catch {
      setAudioNeedsClick(true);
    }
  }, []);

  const cleanup = useCallback(
    (nextState: CallState = "idle") => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      dataChannelRef.current?.close();
      dataChannelRef.current = null;

      pcRef.current?.getSenders().forEach((sender) => sender.track?.stop());
      pcRef.current?.close();
      pcRef.current = null;

      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;

      if (audioElementRef.current) {
        audioElementRef.current.srcObject = null;
      }

      setDcState("closed");
      setRemoteAudioReceived(false);
      setRemoteStreamCount(0);
      setLocalTrackCount(0);
      setState(nextState);
    },
    [setState]
  );

  const acquireMic = useCallback(async () => {
    setErrorMessage(null);
    setState("requesting_mic");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      setMicStatus("granted");
      setState("creating_peer");
      return stream;
    } catch (err) {
      const error = err as { name?: string; message?: string };
      if (error?.name === "NotAllowedError") {
        setErrorMessage("Microphone blocked. Click the lock icon → allow microphone → reload.");
        setMicStatus("denied");
      } else if (error?.name === "NotFoundError") {
        setErrorMessage("No microphone found.");
      } else if (error?.name === "NotReadableError") {
        setErrorMessage("Microphone is in use by another app.");
      } else {
        setErrorMessage(error?.message || "Unable to access microphone.");
      }
      if (debugRealtime) {
        console.log("[realtime] mic_error", error);
      }
      setState("error");
      return null;
    }
  }, [debugRealtime, setState]);

  const handleDataMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        const type = msg.type as string | undefined;
        if (!type) return;
        pushEvent(type);

        if (type === "conversation.item.input_audio_transcription.delta") {
          setUserLive((prev) => `${prev}${msg.delta || ""}`);
        }
        if (type === "conversation.item.input_audio_transcription.completed") {
          const finalText = msg.transcript || msg.text || userLive;
          if (finalText) {
            setUserTranscript((prev) => [prev, finalText].filter(Boolean).join("\n"));
          }
          setUserLive("");
        }

        if (type === "response.output_audio_transcript.delta") {
          setAiLive((prev) => `${prev}${msg.delta || ""}`);
        }
        if (type === "response.output_audio_transcript.done") {
          const finalText = msg.transcript || msg.text || aiLive;
          if (finalText) {
            setAiTranscript((prev) => [prev, finalText].filter(Boolean).join("\n"));
          }
          setAiLive("");
        }
      } catch {
        pushEvent("event_parse_error");
      }
    },
    [aiLive, pushEvent, userLive]
  );

  const sendEvent = useCallback(
    (payload: Record<string, unknown>) => {
      const channel = dataChannelRef.current;
      if (channel && channel.readyState === "open") {
        channel.send(JSON.stringify(payload));
        if (payload.type) {
          pushEvent(`send:${payload.type}`);
        }
      }
    },
    [pushEvent]
  );

  const startCall = useCallback(async () => {
    if (callState !== "idle" && callState !== "error") return;

    setErrorMessage(null);
    setUserTranscript("");
    setUserLive("");
    setAiTranscript("");
    setAiLive("");
    setEventLog([]);
    setEndpointStatus(null);
    setAudioNeedsClick(false);

    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
    }
    connectionTimeoutRef.current = setTimeout(() => {
      if (callStateRef.current !== "connected" && callStateRef.current !== "live") {
        const last = callStateRef.current;
        setErrorMessage(
          `Connection timed out. Last step: ${last}. Check mic permissions and network.`
        );
        if (debugRealtime) {
          console.log("[realtime] connect_timeout", last);
        }
        cleanup("error");
      }
    }, 12000);

    try {
      const stream = await acquireMic();
      if (!stream) return;

      const audioEl = ensureAudioElement();
      await attemptPlay();

      setState("creating_peer");
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      setLocalTrackCount(stream.getTracks().length);

      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (remoteStream && audioEl) {
          audioEl.srcObject = remoteStream;
          attemptPlay();
          setRemoteAudioReceived(true);
        }
        setRemoteStreamCount(event.streams.length);
      };

      pc.onconnectionstatechange = () => {
        setPcConnectionState(pc.connectionState);
      };
      pc.oniceconnectionstatechange = () => {
        setPcIceState(pc.iceConnectionState);
      };
      pc.onsignalingstatechange = () => {
        setPcSignalingState(pc.signalingState);
      };

      const dc = pc.createDataChannel("oai-events");
      dataChannelRef.current = dc;
      setDcState(dc.readyState);
      dc.onopen = () => {
        setDcState("open");
        setState("live");
        sendEvent({
          type: "session.update",
          session: {
            output_modalities: ["audio"],
            audio: {
              input: {
                turn_detection: {
                  type: "semantic_vad",
                  create_response: true,
                  interrupt_response: true,
                },
                transcription: { model: "gpt-4o-mini-transcribe" },
              },
            },
            instructions:
              "You are a realistic finance coffee chat interviewer. Be warm, concise, and ask 1 question at a time. Guide toward a referral moment. If asked too early, redirect politely and revisit later.",
          },
        });
        sendEvent({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions:
              "Say: ‘Hey, thanks for hopping on—can you quickly walk me through your background?’",
          },
        });
      };
      dc.onclose = () => setDcState("closed");
      dc.onmessage = handleDataMessage;

      setState("posting_sdp");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp || "",
      });
      setEndpointStatus(res.status);

      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("application/sdp")) {
        const errorText = await res.text();
        throw new Error(errorText || res.statusText);
      }

      const answerSdp = await res.text();
      setState("setting_remote");
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      setState("connected");
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unable to start call.");
      if (debugRealtime) {
        console.log("[realtime] start_error", err);
      }
      cleanup("error");
    }
  }, [
    acquireMic,
    attemptPlay,
    callState,
    cleanup,
    debugRealtime,
    ensureAudioElement,
    handleDataMessage,
    sendEvent,
    setState,
  ]);

  const endCall = useCallback(() => {
    cleanup("idle");
  }, [cleanup]);

  const retryAudio = useCallback(() => {
    attemptPlay();
  }, [attemptPlay]);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(scenario.track);
    setScenario(sc);
  }, [scenario.track]);

  useEffect(() => {
    return () => {
      cleanup("idle");
    };
  }, [cleanup]);

  const callStatusLabel = useMemo(() => {
    if (callState === "requesting_mic") return "Requesting mic";
    if (callState === "creating_peer") return "Creating peer";
    if (callState === "posting_sdp") return "Posting SDP";
    if (callState === "setting_remote") return "Setting remote";
    if (callState === "connected") return "Connected";
    if (callState === "live") return "Live";
    if (callState === "error") return "Error";
    return "Idle";
  }, [callState]);

  const callStatusTone = useMemo(() => {
    if (callState === "connected" || callState === "live") return "success";
    if (
      callState === "requesting_mic" ||
      callState === "creating_peer" ||
      callState === "posting_sdp" ||
      callState === "setting_remote"
    ) {
      return "warning";
    }
    if (callState === "error") return "warning";
    return "neutral";
  }, [callState]);

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
                    Call Controls
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    Voice interviewer session
                  </div>
                </div>
                <Badge tone={callStatusTone}>{callStatusLabel}</Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                {callState === "idle" || callState === "error" ? (
                  <Button onClick={startCall} type="button">
                    Start Call
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={endCall} type="button">
                    End Call
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setDebugOpen((prev) => !prev)} type="button">
                  {debugOpen ? "Hide Debug" : "Show Debug"}
                </Button>
              </div>
              {audioNeedsClick ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  Audio playback blocked. <Button variant="ghost" onClick={retryAudio}>Click to enable audio</Button>
                </div>
              ) : null}
              {errorMessage ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {errorMessage}
                </div>
              ) : null}
              {micStatus === "denied" ? (
                <div className="mt-3 text-sm text-slate-700">
                  Microphone blocked. Click the lock icon in the browser bar → allow microphone → reload.
                </div>
              ) : null}
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">Conversation transcript</div>
                <Badge tone={callState === "live" ? "success" : "neutral"}>
                  {callState === "live" ? "Live" : "Idle"}
                </Badge>
              </div>
              <div className="mt-4 grid gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">You</div>
                  <div className="mt-2 min-h-[90px] whitespace-pre-wrap text-sm text-slate-800">
                    {userTranscript || userLive ? (
                      <>
                        {userTranscript}
                        {userLive ? <span className="text-slate-500"> {userLive}</span> : null}
                      </>
                    ) : (
                      "Speak to see your transcript."
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interviewer</div>
                  <div className="mt-2 min-h-[90px] whitespace-pre-wrap text-sm text-slate-800">
                    {aiTranscript || aiLive ? (
                      <>
                        {aiTranscript}
                        {aiLive ? <span className="text-slate-500"> {aiLive}</span> : null}
                      </>
                    ) : (
                      "AI responses will appear here."
                    )}
                  </div>
                </div>
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
                <div className="text-base font-semibold text-slate-900">Call status</div>
                <Badge tone="neutral">Realtime</Badge>
              </div>
              <div className="mt-4 text-sm text-slate-700">
                This mode uses OpenAI Realtime over WebRTC. Audio is never stored.
              </div>
              {debugOpen && debugRealtime ? (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Debug</div>
                  <div className="mt-2 space-y-1">
                    <div>Last step: {lastStep}</div>
                    <div>Last step at: {lastStepAt || "-"}</div>
                    <div>Endpoint status: {endpointStatus ?? "-"}</div>
                    <div>pc.connectionState: {pcConnectionState}</div>
                    <div>pc.iceConnectionState: {pcIceState}</div>
                    <div>pc.signalingState: {pcSignalingState}</div>
                    <div>dc.readyState: {dcState}</div>
                    <div>Remote audio received: {remoteAudioReceived ? "yes" : "no"}</div>
                    <div>Local tracks: {localTrackCount}</div>
                    <div>Remote streams: {remoteStreamCount}</div>
                  </div>
                  <div className="mt-3 font-semibold text-slate-900">Recent events</div>
                  <div className="mt-2 space-y-1">
                    {eventLog.length === 0 ? (
                      <div>No events yet.</div>
                    ) : (
                      eventLog.map((entry, index) => <div key={index}>{entry}</div>)
                    )}
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
