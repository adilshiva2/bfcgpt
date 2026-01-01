"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
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

type CallState = "idle" | "requesting_mic" | "connecting" | "live" | "ending";

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
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [difficulty, setDifficulty] = useState<Difficulty>("Standard");

  const [callState, setCallState] = useState<CallState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<"unknown" | "granted" | "denied">("unknown");
  const [connected, setConnected] = useState(false);
  const [remoteAudio, setRemoteAudio] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [eventLog, setEventLog] = useState<string[]>([]);

  const [userTranscript, setUserTranscript] = useState("");
  const [userInterim, setUserInterim] = useState("");
  const [aiTranscript, setAiTranscript] = useState("");
  const [pushToTalk, setPushToTalk] = useState(false);

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
    setEventLog((prev) => [`${new Date().toLocaleTimeString()} ${entry}`, ...prev].slice(0, 20));
  }, []);

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

  const setMicEnabled = useCallback((enabled: boolean) => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }, []);

  const closeConnection = useCallback(() => {
    setCallState("ending");
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    pcRef.current?.getSenders().forEach((sender) => {
      sender.track?.stop();
    });
    pcRef.current?.close();
    pcRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
    }

    setConnected(false);
    setRemoteAudio(false);
    setCallState("idle");
  }, []);

  const handleDataMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        const type = msg.type as string | undefined;
        if (!type) return;

        pushEvent(type);

        const text = msg.delta || msg.transcript || msg.text || "";

        if (type.includes("input_audio") && type.includes("delta") && text) {
          setUserInterim((prev) => `${prev}${text}`);
        }

        if (type.includes("input_audio") && (type.includes("done") || type.includes("completed"))) {
          const finalText = msg.transcript || msg.text || userInterim;
          if (finalText) {
            setUserTranscript((prev) => [prev, finalText].filter(Boolean).join(" "));
          }
          setUserInterim("");
        }

        if (type.includes("response.audio_transcript") && text) {
          setAiTranscript((prev) => `${prev}${text}`);
        }
      } catch {
        pushEvent("event_parse_error");
      }
    },
    [pushEvent, userInterim]
  );

  const sendEvent = useCallback(
    (payload: Record<string, unknown>) => {
      const channel = dataChannelRef.current;
      if (channel && channel.readyState === "open") {
        channel.send(JSON.stringify(payload));
        pushEvent(payload.type ? `send:${payload.type}` : "send:unknown");
      }
    },
    [pushEvent]
  );

  const startCall = useCallback(async () => {
    if (callState !== "idle") return;

    setErrorMessage(null);
    setUserTranscript("");
    setUserInterim("");
    setAiTranscript("");
    setEventLog([]);

    setCallState("requesting_mic");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setMicStatus("granted");

      const audioEl = ensureAudioElement();
      await audioEl.play().catch(() => undefined);

      setCallState("connecting");

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      if (pushToTalk) {
        setMicEnabled(false);
      }

      pc.ontrack = (ev) => {
        const [remoteStream] = ev.streams;
        if (remoteStream && audioEl) {
          audioEl.srcObject = remoteStream;
          audioEl.play().catch(() => undefined);
          setRemoteAudio(true);
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        pushEvent(`ice:${state}`);
        setConnected(state === "connected" || state === "completed");
      };

      const dataChannel = pc.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onopen = () => pushEvent("datachannel:open");
      dataChannel.onclose = () => pushEvent("datachannel:close");
      dataChannel.onmessage = handleDataMessage;

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      const tokenRes = await fetch("/api/realtime/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario: {
            track: scenario.track,
            firmType: scenario.firmType,
            group: scenario.group,
            interviewerVibe: scenario.person.vibe,
            userGoal: "referral",
            difficulty,
          },
        }),
      });

      if (!tokenRes.ok) {
        const errorText = await tokenRes.text();
        throw new Error(errorText || tokenRes.statusText);
      }

      const tokenJson = await tokenRes.json();
      const ephemeralKey = tokenJson?.value || tokenJson?.apiKey || tokenJson?.token;
      if (!ephemeralKey) {
        throw new Error("Missing realtime token");
      }

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime?model=gpt-realtime", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp || "",
      });

      if (!sdpResponse.ok) {
        const errorText = await sdpResponse.text();
        throw new Error(errorText || "Failed to connect to realtime");
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setCallState("live");
      sendEvent({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Start the coffee chat now. Give a brief greeting and 1 opening question.",
        },
      });
    } catch (err) {
      setMicStatus(err instanceof Error && err.message.includes("permission") ? "denied" : micStatus);
      setErrorMessage(err instanceof Error ? err.message : "Unable to start call.");
      closeConnection();
      setCallState("idle");
    }
  }, [
    callState,
    closeConnection,
    difficulty,
    ensureAudioElement,
    handleDataMessage,
    micStatus,
    pushEvent,
    pushToTalk,
    scenario,
    sendEvent,
    setMicEnabled,
  ]);

  const endCall = useCallback(() => {
    closeConnection();
  }, [closeConnection]);

  const testAudio = useCallback(() => {
    sendEvent({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: "Say out loud: \"Audio test: can you hear me?\"",
      },
    });
  }, [sendEvent]);

  const rerollScenarioOnly = useCallback(() => {
    const sc = generateScenario(scenario.track);
    setScenario(sc);
  }, [scenario.track]);

  const callStatusLabel = useMemo(() => {
    if (callState === "requesting_mic") return "Requesting mic";
    if (callState === "connecting") return "Connecting";
    if (callState === "live") return "Live";
    if (callState === "ending") return "Ending";
    return "Idle";
  }, [callState]);

  const callStatusTone = useMemo(() => {
    if (callState === "live") return "success";
    if (callState === "connecting" || callState === "requesting_mic") return "warning";
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
                {callState === "idle" ? (
                  <Button onClick={startCall} type="button">
                    Start Call
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={endCall} type="button">
                    End Call
                  </Button>
                )}
                <Button variant="secondary" onClick={testAudio} type="button" disabled={callState !== "live"}>
                  Test Audio
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => setDebugOpen((prev) => !prev)}
                >
                  {debugOpen ? "Hide Debug" : "Show Debug"}
                </Button>
              </div>
              <div className="mt-4 flex items-center gap-3 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={pushToTalk}
                  onChange={(e) => setPushToTalk(e.target.checked)}
                />
                <span>Push-to-talk fallback</span>
                {pushToTalk ? (
                  <Button
                    variant="secondary"
                    type="button"
                    onMouseDown={() => setMicEnabled(true)}
                    onMouseUp={() => setMicEnabled(false)}
                    onMouseLeave={() => setMicEnabled(false)}
                    onTouchStart={() => setMicEnabled(true)}
                    onTouchEnd={() => setMicEnabled(false)}
                    disabled={callState !== "live"}
                  >
                    Hold to Talk
                  </Button>
                ) : null}
              </div>
              {errorMessage ? (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {errorMessage}
                </div>
              ) : null}
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">Live transcripts</div>
                <Badge tone={callState === "live" ? "success" : "neutral"}>
                  {callState === "live" ? "Listening" : "Idle"}
                </Badge>
              </div>
              <div className="mt-4 grid gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    You
                  </div>
                  <div className="mt-2 min-h-[90px] whitespace-pre-wrap text-sm text-slate-800">
                    {userTranscript || userInterim || "Start speaking to see your transcript."}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Interviewer
                  </div>
                  <div className="mt-2 min-h-[90px] whitespace-pre-wrap text-sm text-slate-800">
                    {aiTranscript || "AI responses will appear here."}
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
                <div className="text-base font-semibold text-slate-900">Session details</div>
                <Badge tone="neutral">Realtime</Badge>
              </div>
              <div className="mt-4 text-sm text-slate-700">
                This mode uses OpenAI Realtime to run a live interviewer. Audio is never stored.
              </div>
              {debugOpen ? (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Debug</div>
                  <div className="mt-2 space-y-1">
                    <div>Mic permission: {micStatus}</div>
                    <div>Connection: {connected ? "connected" : "disconnected"}</div>
                    <div>Remote audio: {remoteAudio ? "received" : "not yet"}</div>
                    <div>Call state: {callState}</div>
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
