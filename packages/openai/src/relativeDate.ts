const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

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

function endOfLocalDay(localDate: Date, timeZone: string): string {
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

export function relativeDeadline(
  text: string,
  requestedAt: string,
  timeZone: string,
): string | null {
  const [year, month, day] = localParts(new Date(requestedAt), timeZone);
  const localDate = new Date(Date.UTC(year!, month! - 1, day!));

  const period =
    /\bend\s+of\s+(?:the\s+)?(?:(this|next)\s+)?(month|week)\b/i.exec(text);
  if (period) {
    const next = period[1]?.toLowerCase() === "next";
    if (period[2]!.toLowerCase() === "month") {
      localDate.setUTCMonth(localDate.getUTCMonth() + (next ? 2 : 1), 0);
    } else {
      const friday = 5;
      let offset = (friday - localDate.getUTCDay() + 7) % 7;
      if (next) offset += 7;
      localDate.setUTCDate(localDate.getUTCDate() + offset);
    }
    return endOfLocalDay(localDate, timeZone);
  }

  const span =
    /\b(?:in|within)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s+(business\s+)?(days?|weeks?)\b/i.exec(
      text,
    );
  if (span) {
    const raw = span[1]!.toLowerCase();
    const count = /^\d+$/.test(raw) ? Number(raw) : (numberWords[raw] ?? 1);
    const unit = span[3]!.toLowerCase();
    if (unit.startsWith("week")) {
      localDate.setUTCDate(localDate.getUTCDate() + count * 7);
    } else if (span[2]) {
      let remaining = count;
      while (remaining > 0) {
        localDate.setUTCDate(localDate.getUTCDate() + 1);
        const weekday = localDate.getUTCDay();
        if (weekday !== 0 && weekday !== 6) remaining -= 1;
      }
    } else {
      localDate.setUTCDate(localDate.getUTCDate() + count);
    }
    return endOfLocalDay(localDate, timeZone);
  }

  const match =
    /\b(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|today)\b/i.exec(
      text,
    );
  if (!match) return null;
  const word = match[2]!.toLowerCase();
  let offset = word === "tomorrow" ? 1 : 0;
  if (weekdays.includes(word)) {
    offset = (weekdays.indexOf(word) - localDate.getUTCDay() + 7) % 7;
    if (offset === 0 && match[1]?.toLowerCase() === "next") offset = 7;
  }
  localDate.setUTCDate(localDate.getUTCDate() + offset);
  return endOfLocalDay(localDate, timeZone);
}
