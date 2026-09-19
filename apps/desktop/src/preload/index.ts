import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopSignal } from "../shared/bridge.js";

const bridge: DesktopBridge = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  ready: () => ipcRenderer.invoke("desktop:ready"),
  hideOverlay: () => ipcRenderer.invoke("desktop:hide"),
  toggleOverlay: () => ipcRenderer.invoke("desktop:toggle"),
  setMode: (mode) => ipcRenderer.invoke("desktop:mode", mode),
  openDashboard: (projectId) =>
    ipcRenderer.invoke("desktop:dashboard", projectId),
  saveSettings: (settings) => ipcRenderer.invoke("desktop:settings", settings),
  getPermissionStatus: () => ipcRenderer.invoke("desktop:permissions"),
  requestMicrophone: () => ipcRenderer.invoke("desktop:microphone"),
  openPermissionSettings: (permission) =>
    ipcRenderer.invoke("desktop:permission-settings", permission),
  listScreenSources: () => ipcRenderer.invoke("desktop:sources"),
  selectScreenSource: (sourceId) =>
    ipcRenderer.invoke("desktop:select-source", sourceId),
  pasteFiles: () => ipcRenderer.invoke("desktop:paste"),
  notify: (event) => ipcRenderer.invoke("desktop:notify", event),
  onSignal: (listener) => {
    const handle = (_event: Electron.IpcRendererEvent, signal: DesktopSignal) =>
      listener(signal);
    ipcRenderer.on("desktop:signal", handle);
    return () => ipcRenderer.removeListener("desktop:signal", handle);
  },
};
contextBridge.exposeInMainWorld("moleculeDesktop", bridge);
