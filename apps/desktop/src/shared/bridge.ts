import { z } from "zod";

export const OverlayModeSchema = z.enum([
  "hidden",
  "compact",
  "conversation",
  "company",
  "alert",
]);
export type OverlayMode = z.infer<typeof OverlayModeSchema>;

export const SettingsSchema = z.object({
  shortcut: z.string().min(1).max(80).default("Alt+Space"),
  microphoneDevice: z.string().max(300).default(""),
  voiceEnabled: z.boolean().default(true),
  notificationsEnabled: z.boolean().default(false),
  autoExpandOnAlert: z.boolean().default(true),
  screenShareConsent: z.boolean().default(false),
  position: z.object({ x: z.number().int(), y: z.number().int() }).optional(),
  lastProjectId: z.uuid().optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type PermissionStatus =
  "not-determined" | "granted" | "denied" | "restricted" | "unknown";
export interface DesktopBootstrap {
  apiUrl: string;
  settings: Settings;
  shortcut: string | null;
}
export interface CapturedFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}
export interface ScreenSource {
  id: string;
  name: string;
}
export type DesktopSignal =
  | { type: "visibility"; visible: boolean }
  | { type: "project"; projectId: string }
  | { type: "start-voice" | "mute" | "settings" };

export interface DesktopBridge {
  bootstrap(): Promise<DesktopBootstrap>;
  ready(): Promise<void>;
  hideOverlay(): Promise<void>;
  toggleOverlay(): Promise<void>;
  setMode(mode: OverlayMode): Promise<void>;
  openDashboard(projectId?: string): Promise<void>;
  saveSettings(settings: Settings): Promise<DesktopBootstrap>;
  getPermissionStatus(): Promise<{
    microphone: PermissionStatus;
    screen: PermissionStatus;
  }>;
  requestMicrophone(): Promise<boolean>;
  openPermissionSettings(permission: "microphone" | "screen"): Promise<void>;
  listScreenSources(): Promise<ScreenSource[]>;
  selectScreenSource(sourceId: string): Promise<void>;
  pasteFiles(): Promise<CapturedFile[]>;
  notify(event: {
    eventId: string;
    projectId: string;
    kind: string;
    label: string;
  }): Promise<void>;
  onSignal(listener: (signal: DesktopSignal) => void): () => void;
}

declare global {
  interface Window {
    moleculeDesktop: DesktopBridge;
  }
}
