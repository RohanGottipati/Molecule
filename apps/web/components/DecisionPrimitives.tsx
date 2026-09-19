import { humanize, safeHref } from "../lib/workspace";

export function Badge({ value }: { value: string }) {
  const good = [
    "active",
    "online",
    "ready",
    "VALID",
    "CAN_ACCEPT",
    "SUCCEEDED",
    "COMPLETED",
  ].includes(value);
  const bad = [
    "offline",
    "conflicted",
    "quarantined",
    "FAILED",
    "DECLINE",
    "ERROR",
    "UNSAT",
  ].includes(value);
  return (
    <span
      className={`badge ${good ? "badge-good" : bad ? "badge-bad" : "badge-neutral"}`}
    >
      {humanize(value)}
    </span>
  );
}

export function DecisionLink({
  href,
  children,
}: {
  href: string | undefined;
  children: React.ReactNode;
}) {
  const safe = safeHref(href);
  return safe ? (
    <a
      className="external-link"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children} ↗
    </a>
  ) : null;
}
