import type { PlanNodeKind } from "../lib/planVisuals";

const paths: Record<PlanNodeKind, string> = {
  SUPPLY: "M4 8 12 4l8 4-8 4-8-4Zm0 0v8l8 4m0-4 8-4V8m-8 4v8",
  TRANSFORM: "M4 21V10l8-6 8 6v11H4Zm5-4h6M9 13h6",
  ASSEMBLE: "M4 7l8-4 8 4-8 4-8-4Zm0 5 8 4 8-4M4 16l8 4 8-4",
  FULFILL:
    "M3 7h11v9H3V7Zm11 3h4l3 3v3h-7v-6ZM6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
};

export function PlanKindIcon({ kind }: { kind: PlanNodeKind }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
