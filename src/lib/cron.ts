/**
 * Minimal 5-field cron matcher, UTC only.
 *
 * Supported subset — `minute hour day-of-month month day-of-week`, where each
 * field is a comma-separated list of:
 *   `*`            every value
 *   `n`            a single value
 *   `a-b`          an inclusive range
 *   `*​/s`, `a-b/s` the above with a step
 *
 * Day-of-week is 0-6 with 0 = Sunday; 7 is accepted and normalised to 0.
 *
 * NOT supported (parsing throws, and the job is skipped with the error
 * recorded rather than silently never firing): month/day NAMES (JAN, MON),
 * `L`, `W`, `#`, `?`, `@hourly`-style nicknames, seconds, a 6th year field,
 * bare `n/s` (a step needs `*` or a range), and per-job timezones.
 *
 * Day-of-month / day-of-week follow the vixie-cron OR rule: when BOTH fields
 * are restricted (the raw text does not start with `*`), the expression matches
 * if EITHER matches. Otherwise both must match.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(raw: string, min: number, max: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (piece === "") throw new CronError(`${label}: empty list item in "${raw}"`);

    const [spec, stepRaw, ...rest] = piece.split("/");
    if (rest.length > 0) throw new CronError(`${label}: more than one "/" in "${piece}"`);

    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw new CronError(`${label}: step must be a positive integer in "${piece}"`);
      step = Number(stepRaw);
      if (step === 0) throw new CronError(`${label}: step must be > 0 in "${piece}"`);
    }

    let lo: number;
    let hi: number;
    if (spec === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+-\d+$/.test(spec ?? "")) {
      const [a, b] = spec!.split("-").map(Number) as [number, number];
      lo = a;
      hi = b;
      if (lo > hi) throw new CronError(`${label}: range start > end in "${piece}"`);
    } else if (/^\d+$/.test(spec ?? "")) {
      if (stepRaw !== undefined) {
        throw new CronError(`${label}: a step needs "*" or a range, got "${piece}"`);
      }
      lo = Number(spec);
      hi = lo;
    } else {
      throw new CronError(`${label}: unsupported term "${piece}" (names, L, W, #, ? are not supported)`);
    }

    if (lo < min || hi > max) {
      throw new CronError(`${label}: "${piece}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new CronError(`${label}: "${raw}" matches nothing`);
  return out;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(`expected 5 cron fields, got ${fields.length} in "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  const dowSet = new Set<number>();
  for (const v of parseField(dow, 0, 7, "day-of-week")) dowSet.add(v === 7 ? 0 : v);

  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    dom: parseField(dom, 1, 31, "day-of-month"),
    month: parseField(month, 1, 12, "month"),
    dow: dowSet,
    domRestricted: !dom.startsWith("*"),
    dowRestricted: !dow.startsWith("*"),
  };
}

/** Does `expr` fire during the UTC minute containing `date`? */
export function matchesCron(expr: string, date: Date): boolean {
  return matchesParsed(parseCron(expr), date);
}

export function matchesParsed(c: ParsedCron, date: Date): boolean {
  if (!c.minute.has(date.getUTCMinutes())) return false;
  if (!c.hour.has(date.getUTCHours())) return false;
  if (!c.month.has(date.getUTCMonth() + 1)) return false;

  const domOk = c.dom.has(date.getUTCDate());
  const dowOk = c.dow.has(date.getUTCDay());
  return c.domRestricted && c.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

/** `YYYY-MM-DDTHH:MMZ` — the identity of a one-minute scheduling slot. */
export function isoMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

/**
 * Every slot in the `windowMinutes` ending at (and including) `tickTime` that
 * `expr` fires in, oldest first.
 *
 * A Worker cron tick at T is treated as covering the T-window+1 .. T minutes,
 * so with TICK_MINUTES matching the wrangler trigger the ticks partition the
 * timeline exactly: no slot is evaluated twice, and none is missed because a
 * job's minute field did not land on a tick boundary.
 */
export function dueSlots(expr: string, tickTime: number, windowMinutes: number): string[] {
  const parsed = parseCron(expr);
  const slots: string[] = [];
  const tickMinuteStart = Math.floor(tickTime / 60_000) * 60_000;
  for (let i = windowMinutes - 1; i >= 0; i--) {
    const d = new Date(tickMinuteStart - i * 60_000);
    if (matchesParsed(parsed, d)) slots.push(isoMinute(d));
  }
  return slots;
}
