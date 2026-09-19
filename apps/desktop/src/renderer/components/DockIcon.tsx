export type DockIconName =
  | "mic"
  | "muted"
  | "send"
  | "stop"
  | "attach"
  | "screen"
  | "expand"
  | "collapse"
  | "close"
  | "settings"
  | "command";

const paths: Record<DockIconName, string> = {
  mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V5ZM5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8",
  muted:
    "m3 3 18 18M9 5a3 3 0 0 1 6 0v6M9 9v2a3 3 0 0 0 5 2M5 10v1a7 7 0 0 0 12 5M19 10v1M12 18v4M8 22h8",
  send: "M12 19V5m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6Z",
  attach: "m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9M6 14l8-8",
  screen: "M3 4h18v12H3ZM12 16v4M8 20h8",
  expand: "m6 9 6 6 6-6",
  collapse: "m6 15 6-6 6 6",
  close: "m6 6 12 12M6 18 18 6",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  command:
    "M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4M14 3h7v7M11 13 21 3",
};

export function DockIcon({ name }: { name: DockIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
