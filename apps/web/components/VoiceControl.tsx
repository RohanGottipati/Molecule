export function VoiceControl() {
  return (
    <span
      className="voice-unavailable"
      title="Voice is not enabled in this web release. Use the text conversation."
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M3 3l18 18" />
      </svg>
      Voice unavailable · use text
    </span>
  );
}
