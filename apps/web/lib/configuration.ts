import { getDemoCapabilities } from "./api";

export type DemoConfiguration = {
  enabled: boolean;
  resetAvailable: boolean;
  loading: boolean;
  error: string | null;
};

export async function readDemoConfiguration(
  publish: (state: DemoConfiguration) => void,
  signal?: AbortSignal,
): Promise<void> {
  publish({
    enabled: false,
    resetAvailable: false,
    loading: true,
    error: null,
  });
  try {
    const capabilities = await getDemoCapabilities(signal);
    const enabled = !signal?.aborted && capabilities.demoMode;
    publish({
      enabled,
      resetAvailable: enabled && capabilities.resetAvailable,
      loading: false,
      error: null,
    });
  } catch {
    publish({
      enabled: false,
      resetAvailable: false,
      loading: false,
      error: "Demo configuration unavailable. Recovery controls are disabled.",
    });
  }
}
