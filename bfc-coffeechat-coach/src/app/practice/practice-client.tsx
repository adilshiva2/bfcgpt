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
  | "fetching_token"
  | "setting_sdp"
  | "connected"
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

function getSpeechRecognition(): SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionImpl) return null;
  return new SpeechRecognitionImpl();
}

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<"unknown" | "granted" | "denied">("unknown");
  const [connected, setConnected] = useState(false);
  const [remoteAudio, setRemoteAudio] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [permissionsState, setPermissionsState] = useState<string>("unknown");
  const [secureContext, setSecureContext] = useState<string>("unknown");
  const [mediaDevicesAvailable, setMediaDevicesAvailable] = useState(false);
  const [micTrackInfo, setMicTrackInfo] = useState<string>("none");
  const [lastStep, setLastStep] = useState<string>("idle");
  const [lastStepAt, setLastStepAt] = useState<string | null>(null);
  const [tokenStatus, setTokenStatus] = useState<number | null>(null);
  const [tokenKeys, setTokenKeys] = useState<string>("none");
  const [iceState, setIceState] = useState<string>("unknown");
  const [remoteStreamCount, setRemoteStreamCount] = useState(0);
  const [localTrackCount, setLocalTrackCount] = useState(0);
  const [transitionTimes, setTransitionTimes] = useState<Record<CallState, string | null>>({
    idle: null,
    requesting_mic: null,
    creating_peer: null,
    fetching_token: null,
    setting_sdp: null,
    connected: null,
    error: null,
  });

  const [userTranscript, setUserTranscript] = useState("");
  const [userInterim, setUserInterim] = useState("");
  const [aiTranscript, setAiTranscript] = useState("");
  const [pushToTalk, setPushToTalk] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [transcriptFinal, setTranscriptFinal] = useState("");
  const [transcriptInterim, setTranscriptInterim] = useState("");
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
    setEventLog((prev) => [`${new Date().toLocaleTimeString()} ${entry}`, ...prev].slice(0, 20));
  }, []);

  const setState = useCallback(
    (state: CallState) => {
      setCallState(state);
      callStateRef.current = state;
      setTransitionTimes((prev) => ({ ...prev, [state]: new Date().toLocaleTimeString() }));
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

  const setMicEnabled = useCallback((enabled: boolean) => {
    mediaStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }, []);

  const closeConnection = useCallback((nextState: CallState = "idle") => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    pcRef.current?.getSenders().forEach((sender) => {
      sender.track?.stop();
    });
    pcRef.current?.close();
    pcRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
    }

    setConnected(false);
    setRemoteAudio(false);
    setState(nextState);
  }, [setState]);

  const refreshMicDiagnostics = useCallback(() => {
    const track = mediaStreamRef.current?.getAudioTracks()[0];
    if (!track) {
      setMicTrackInfo("none");
      return;
    }
    setMicTrackInfo(
      `enabled=${track.enabled} muted=${track.muted} readyState=${track.readyState} label=${track.label || "unknown"}`
    );
  }, []);

  const acquireMic = useCallback(async () => {
    setErrorMessage(null);
    setState("requesting_mic");

    let acquired = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Mic permission pending—check the browser prompt or site settings."));
      }, 8000);
    });

    try {
      const stream = (await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        timeoutPromise,
      ])) as MediaStream;

      mediaStreamRef.current = stream;
      acquired = true;
      setMicStatus("granted");
      refreshMicDiagnostics();
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
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      setCallState((prev) => {
        if (!acquired && prev === "requesting_mic") {
          setTransitionTimes((times) => ({
            ...times,
            error: new Date().toLocaleTimeString(),
          }));
          if (debugRealtime) {
            console.log("[realtime] state -> error (requesting_mic timeout)");
          }
          return "error";
        }
        return prev;
      });
    }
  }, [debugRealtime, refreshMicDiagnostics, setState]);

  const retryMic = useCallback(async () => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    await acquireMic();
  }, [acquireMic]);

  useEffect(() => {
    if (!debugRealtime) return;
    setSecureContext(typeof window !== "undefined" ? String(window.isSecureContext) : "unknown");
    const hasMediaDevices = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices);
    setMediaDevicesAvailable(hasMediaDevices);
    if (!hasMediaDevices) {
      setPermissionsState("mediaDevices unavailable");
      return;
    }
    if (!navigator.permissions?.query) {
      setPermissionsState("permissions API unavailable");
      return;
    }
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((result) => {
        setPermissionsState(result.state);
      })
      .catch(() => setPermissionsState("unknown"));
  }, [debugRealtime]);

  useEffect(() => {
    return () => {
      closeConnection("idle");
    };
  }, [closeConnection]);

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
    if (callState !== "idle" && callState !== "error") return;

    setErrorMessage(null);
    setUserTranscript("");
    setUserInterim("");
    setAiTranscript("");
    setEventLog([]);
    setTokenStatus(null);
    setTokenKeys("none");
    setIceState("unknown");
    setRemoteStreamCount(0);
    setLocalTrackCount(0);

    try {
      const stream = await acquireMic();
      if (!stream) return;

      const audioEl = ensureAudioElement();
      await audioEl.play().catch(() => undefined);

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        if (callStateRef.current !== "connected") {
          const last = callStateRef.current;
          setErrorMessage(
            `Connection timed out. Last step: ${last}. Check mic permissions and network.`
          );
          if (debugRealtime) {
            console.log("[realtime] connect_timeout", last);
          }
          closeConnection("error");
        }
      }, 10000);

      setState("creating_peer");
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      setLocalTrackCount(stream.getTracks().length);

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
        setRemoteStreamCount(ev.streams.length);
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        pushEvent(`ice:${state}`);
        setIceState(state);
        setConnected(state === "connected" || state === "completed");
      };

      const dataChannel = pc.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.onopen = () => pushEvent("datachannel:open");
      dataChannel.onclose = () => pushEvent("datachannel:close");
      dataChannel.onmessage = handleDataMessage;

      setState("fetching_token");
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

      setTokenStatus(tokenRes.status);
      const tokenText = await tokenRes.text();
      let tokenJson: Record<string, unknown> = {};
      try {
        tokenJson = tokenText ? (JSON.parse(tokenText) as Record<string, unknown>) : {};
      } catch {
        tokenJson = {};
      }
      setTokenKeys(Object.keys(tokenJson).join(", ") || "none");

      if (!tokenRes.ok) {
        throw new Error((tokenJson.error as string) || tokenRes.statusText);
      }

      const ephemeralKey = tokenJson?.value || tokenJson?.apiKey || tokenJson?.token;
      if (!ephemeralKey) {
        throw new Error("Missing realtime token");
      }

      setState("setting_sdp");
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

      setState("connected");
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      sendEvent({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Audio test: can you hear me? Start the coffee chat now with a greeting and 1 opening question.",
        },
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unable to start call.");
      if (debugRealtime) {
        console.log("[realtime] start_error", err);
      }
      closeConnection("error");
    }
  }, [
    acquireMic,
    callState,
    closeConnection,
    difficulty,
    debugRealtime,
    ensureAudioElement,
    handleDataMessage,
    pushEvent,
    pushToTalk,
    scenario,
    sendEvent,
    setMicEnabled,
    setState,
  ]);

  const endCall = useCallback(() => {
    closeConnection("idle");
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
    if (callState === "creating_peer") return "Creating peer";
    if (callState === "fetching_token") return "Fetching token";
    if (callState === "setting_sdp") return "Setting SDP";
    if (callState === "connected") return "Connected";
    if (callState === "error") return "Error";
    return "Idle";
  }, [callState]);

  const callStatusTone = useMemo(() => {
    if (callState === "connected") return "success";
    if (callState === "requesting_mic" || callState === "creating_peer" || callState === "fetching_token" || callState === "setting_sdp") {
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
                <Button
                  variant="secondary"
                  onClick={retryMic}
                  type="button"
                  disabled={callState === "requesting_mic"}
                >
                  Retry Mic
                </Button>
                <Button variant="ghost" onClick={() => closeConnection("idle")} type="button">
                  Reset
                </Button>
                <Button
                  variant="secondary"
                  onClick={testAudio}
                  type="button"
                  disabled={callState !== "connected"}
                >
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
                    disabled={callState !== "connected"}
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
              </div>
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
              <div className="mt-4 min-h-[120px] whitespace-pre-wrap text-sm text-slate-800">
                {transcriptFinal || transcriptInterim ? (
                  <>
                    {transcriptFinal ? <span>{transcriptFinal}</span> : null}
                    {transcriptInterim ? (
                      <span className="text-slate-500"> {transcriptInterim}</span>
                    ) : null}
                  </>
                ) : (
                  "Start transcription to capture your response."
                )}
              </div>
            </Card>
          </motion.div>

          <motion.div whileHover={{ y: -2 }} transition={{ type: "spring", stiffness: 300 }}>
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div className="text-base font-semibold text-slate-900">Live transcripts</div>
                <Badge tone={callState === "connected" ? "success" : "neutral"}>
                  {callState === "connected" ? "Listening" : "Idle"}
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
              {debugOpen && debugRealtime ? (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Debug</div>
                  <div className="mt-2 space-y-1">
                    <div>isSecureContext: {secureContext}</div>
                    <div>mediaDevices: {String(mediaDevicesAvailable)}</div>
                    <div>permissions: {permissionsState}</div>
                    <div>Mic permission: {micStatus}</div>
                    <div>Connection: {connected ? "connected" : "disconnected"}</div>
                    <div>Remote audio: {remoteAudio ? "received" : "not yet"}</div>
                    <div>Call state: {callState}</div>
                    <div>Last step: {lastStep}</div>
                    <div>Last step at: {lastStepAt || "-"}</div>
                    <div>Token status: {tokenStatus ?? "-"}</div>
                    <div>Token keys: {tokenKeys}</div>
                    <div>ICE state: {iceState}</div>
                    <div>Local tracks: {localTrackCount}</div>
                    <div>Remote streams: {remoteStreamCount}</div>
                    <div>Track: {micTrackInfo}</div>
                    <div>Idle at: {transitionTimes.idle || "-"}</div>
                    <div>Requesting at: {transitionTimes.requesting_mic || "-"}</div>
                    <div>Creating peer at: {transitionTimes.creating_peer || "-"}</div>
                    <div>Fetching token at: {transitionTimes.fetching_token || "-"}</div>
                    <div>Setting SDP at: {transitionTimes.setting_sdp || "-"}</div>
                    <div>Connected at: {transitionTimes.connected || "-"}</div>
                    <div>Error at: {transitionTimes.error || "-"}</div>
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
