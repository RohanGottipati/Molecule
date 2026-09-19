import { z } from "zod";

export const OverlayModeSchema = z.enum([
  "hidden",
  "compact",
  "conversation",
  "company",
  "alert",
]);
export type OverlayMode = z.infer<typeof OverlayModeSchema>;
export const DashboardViewSchema = z.enum([
  "command",
  "merchants",
  "reality",
  "operations",
  "execution",
]);
export type DashboardView = z.infer<typeof DashboardViewSchema>;
export const ActiveProjectSchema = z.uuid().nullable();
export const DashboardRequestSchema = z
  .object({
    projectId: z.uuid().optional(),
    view: DashboardViewSchema.optional(),
  })
  .strict();

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
export const SettingsPatchSchema = SettingsSchema.extend({
  shortcut: SettingsSchema.shape.shortcut.removeDefault(),
  microphoneDevice: SettingsSchema.shape.microphoneDevice.removeDefault(),
  voiceEnabled: SettingsSchema.shape.voiceEnabled.removeDefault(),
  notificationsEnabled:
    SettingsSchema.shape.notificationsEnabled.removeDefault(),
  autoExpandOnAlert: SettingsSchema.shape.autoExpandOnAlert.removeDefault(),
  screenShareConsent: SettingsSchema.shape.screenShareConsent.removeDefault(),
})
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
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
  openDashboard(projectId?: string, view?: DashboardView): Promise<void>;
  setActiveProject?(projectId: string | null): Promise<void>;
  saveSettings(settings: SettingsPatch): Promise<DesktopBootstrap>;
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
