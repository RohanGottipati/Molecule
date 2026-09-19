import { getDemoMode } from "./api";

export type DemoConfiguration = {
  enabled: boolean;
  loading: boolean;
  error: string | null;
};

export async function readDemoConfiguration(
  publish: (state: DemoConfiguration) => void,
  signal?: AbortSignal,
): Promise<void> {
  publish({ enabled: false, loading: true, error: null });
  try {
    const enabled = await getDemoMode(signal);
    publish({
      enabled: !signal?.aborted && enabled,
      loading: false,
      error: null,
    });
  } catch {
    publish({
      enabled: false,
      loading: false,
      error: "Demo configuration unavailable. Recovery controls are disabled.",
    });
  }
}
