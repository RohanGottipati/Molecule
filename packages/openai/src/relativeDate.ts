const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function localParts(date: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return ["year", "month", "day", "hour", "minute", "second"].map((type) =>
    Number(parts.find((part) => part.type === type)?.value),
  );
}

export function relativeDeadline(
  text: string,
  requestedAt: string,
  timeZone: string,
): string | null {
  const match =
    /\b(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|today)\b/i.exec(
      text,
    );
  if (!match) return null;
  const [year, month, day] = localParts(new Date(requestedAt), timeZone);
  const localDate = new Date(Date.UTC(year!, month! - 1, day!));
  const word = match[2]!.toLowerCase();
  let offset = word === "tomorrow" ? 1 : 0;
  if (weekdays.includes(word)) {
    offset = (weekdays.indexOf(word) - localDate.getUTCDay() + 7) % 7;
    if (offset === 0 && match[1]?.toLowerCase() === "next") offset = 7;
  }
  localDate.setUTCDate(localDate.getUTCDate() + offset);
  localDate.setUTCHours(23, 59, 59, 0);
  const wallTime = localDate.getTime();
  let instant = wallTime;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const [y, m, d, h, minute, second] = localParts(
      new Date(instant),
      timeZone,
    );
    const rendered = Date.UTC(y!, m! - 1, d!, h!, minute!, second!);
    instant += wallTime - rendered;
  }
  return new Date(instant).toISOString();
}
