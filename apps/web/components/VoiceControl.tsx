"use client";

import { useRef, useState } from "react";

import {
  approvePlan,
  getOrder,
  realtimeSecret,
  submitMessage,
  triggerSupplierOffline,
} from "../lib/api";

export function VoiceControl({ orderId }: { orderId: string }) {
  const peer = useRef<RTCPeerConnection | null>(null);
  const [state, setState] = useState<
    "idle" | "connecting" | "listening" | "speaking" | "live" | "error"
  >("idle");

  async function runTool(name: string, rawArguments: string): Promise<unknown> {
    const args = JSON.parse(rawArguments || "{}") as Record<string, unknown>;
    if (name === "compile_intent") {
      return submitMessage(orderId, String(args.text ?? ""));
    }
    if (name === "update_constraint") {
      const kind = String(args.kind ?? "other") as
        | "constraint"
        | "preference"
        | "quantity"
        | "deadline"
        | "budget"
        | "other";
      const text = String(args.text ?? "");
      return submitMessage(orderId, text, { kind, text });
    }
    const order = await getOrder(orderId);
    if (name === "get_order_status") {
      return {
        state: order.state,
        intentVersion: order.intentVersion,
        planStatus: order.activePlan?.status ?? null,
        totalCost: order.activePlan?.totalCost ?? null,
        currency: order.activePlan?.currency ?? order.intent?.currency ?? null,
        estimatedCompletion: order.activePlan?.estimatedCompletion ?? null,
      };
    }
    if (name === "explain_current_plan") {
      return {
        status: order.activePlan?.status ?? null,
        totalCost: order.activePlan?.totalCost ?? null,
        currency: order.activePlan?.currency ?? null,
        estimatedCompletion: order.activePlan?.estimatedCompletion ?? null,
        nodes:
          order.activePlan?.nodes.map(({ kind, merchantId, quantity }) => ({
            kind,
            merchantId,
            quantity,
          })) ?? [],
      };
    }
    if (name === "approve_and_execute") {
      if (!order.activePlan)
        throw new Error("There is no active plan to approve");
      return approvePlan(orderId, order.activePlan.planId, order.intentVersion);
    }
    if (name === "trigger_demo_failure") {
      return triggerSupplierOffline(orderId, String(args.merchantId ?? ""));
    }
    throw new Error(`Unknown realtime tool: ${name}`);
  }

  async function stop() {
    peer.current?.getSenders().forEach((sender) => sender.track?.stop());
    peer.current?.close();
    peer.current = null;
    setState("idle");
  }

  async function start() {
    setState("connecting");
    try {
      const secret = await realtimeSecret(orderId);
      const connection = new RTCPeerConnection();
      peer.current = connection;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      connection.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null;
      };
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      media.getTracks().forEach((track) => connection.addTrack(track, media));
      const channel = connection.createDataChannel("oai-events");
      channel.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as {
          type?: string;
          name?: string;
          call_id?: string;
          arguments?: string;
        };
        if (event.type === "input_audio_buffer.speech_started") {
          setState("listening");
          channel.send(JSON.stringify({ type: "response.cancel" }));
        } else if (
          event.type === "response.audio.delta" ||
          event.type === "response.output_audio.delta"
        ) {
          setState("speaking");
        } else if (
          event.type === "response.audio.done" ||
          event.type === "response.output_audio.done"
        ) {
          setState("live");
        } else if (
          event.type === "response.function_call_arguments.done" &&
          event.name &&
          event.call_id
        ) {
          void runTool(event.name, event.arguments ?? "{}")
            .then((output) => {
              channel.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify(output),
                  },
                }),
              );
              channel.send(JSON.stringify({ type: "response.create" }));
            })
            .catch((error: unknown) => {
              channel.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    call_id: event.call_id,
                    output: JSON.stringify({
                      error:
                        error instanceof Error ? error.message : "Tool failed",
                    }),
                  },
                }),
              );
              channel.send(JSON.stringify({ type: "response.create" }));
            });
        }
      };
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!response.ok)
        throw new Error(`Realtime connection failed (${response.status})`);
      await connection.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      });
      setState("live");
    } catch {
      await stop();
      setState("error");
    }
  }

  return (
    <button
      className={`voice ${state}`}
      type="button"
      onClick={() =>
        void (["live", "listening", "speaking"].includes(state)
          ? stop()
          : start())
      }
      disabled={state === "connecting"}
      aria-label={
        ["live", "listening", "speaking"].includes(state)
          ? "Stop voice"
          : "Start voice"
      }
    >
      <span className="voice-dot" />
      {state === "live"
        ? "Voice live"
        : state === "listening"
          ? "Listening"
          : state === "speaking"
            ? "Speaking"
            : state === "connecting"
              ? "Connecting"
              : state === "error"
                ? "Voice unavailable"
                : "Talk to Molecule"}
    </button>
  );
}
