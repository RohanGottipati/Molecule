import { useEffect, useState, useSyncExternalStore } from "react";
import { RealtimeClient } from "./services/realtime-client.js";
import { ToolDispatcher } from "./services/tool-dispatcher.js";
import type { DesktopStore } from "./state/desktop-store.js";

export function useVoice(store: DesktopStore) {
  const [voice] = useState(
    () =>
      new RealtimeClient({
        createSession: (projectId) =>
          store.api.createRealtimeSession(projectId),
        permission: () => store.bridge.requestMicrophone(),
        microphoneDevice: () =>
          store.getSnapshot().bootstrap?.settings.microphoneDevice ?? "",
        mockProviders: () => store.getSnapshot().mockProviders,
        refresh: async () => {
          await store.ensureProject();
          await store.refresh();
          const result = store.getSnapshot();
          if (!result.project)
            throw new DOMException("Project changed", "AbortError");
          return { project: result.project, contexts: result.attachments };
        },
        tools: new ToolDispatcher((command, actionId) =>
          store.command(command, actionId),
        ),
      }),
  );
  const state = useSyncExternalStore(voice.subscribe, voice.getSnapshot);
  const toggle = async () => {
    if (!["idle", "error"].includes(voice.getSnapshot().state)) {
      voice.stop();
      return;
    }
    void store
      .mode("conversation")
      .catch((error: unknown) => store.error(error));
    if (!store.getSnapshot().bootstrap?.settings.voiceEnabled)
      throw new Error("Enable voice in Settings to start a conversation.");
    await voice.start();
  };
  useEffect(() => {
    store.onProjectChanging = () => voice.clearConversation();
    const unsubscribe = store.bridge.onSignal((signal) => {
      if (
        (signal.type === "visibility" && !signal.visible) ||
        signal.type === "project"
      )
        voice.stop();
      if (signal.type === "mute") voice.mute(!voice.getSnapshot().muted);
      if (signal.type === "start-voice")
        void toggle().catch((error: unknown) => store.error(error));
    });
    store.onBackendEvent = (event) => {
      if (
        [
          "recovery.completed",
          "recovery.failed",
          "recovery.approval.required",
        ].includes(event.eventType)
      )
        voice.announce(
          JSON.stringify({ event: event.eventType, ...event.payload }),
        );
    };
    store.onContextAttached = () => {
      const current = store.getSnapshot();
      if (current.project)
        voice.context({
          project: current.project,
          contexts: current.attachments,
        });
    };
    return () => {
      unsubscribe();
      voice.stop();
      store.onBackendEvent = undefined;
      store.onContextAttached = undefined;
      store.onProjectChanging = undefined;
    };
  }, [store, voice]);
  return { voice, state, toggle };
}
