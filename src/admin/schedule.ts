export type ScheduleCadence = "daily" | "weekdays" | "weekly" | "monthly";

export interface HumanSchedule {
  cadence: ScheduleCadence;
  hour: number;
  minute: number;
  /** 0 = Sunday, 1 = Monday … 6 = Saturday. */
  weekday?: number;
  /** Kept to 1–28 so every month has the selected day. */
  monthday?: number;
}

const WEEKDAYS = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
] as const;

function integer(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} doit être un entier entre ${min} et ${max}.`);
  }
  return n;
}

export function normalizeHumanSchedule(input: unknown): HumanSchedule {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("La programmation est absente.");
  }
  const value = input as Record<string, unknown>;
  const cadence = value["cadence"];
  if (!["daily", "weekdays", "weekly", "monthly"].includes(String(cadence))) {
    throw new Error("La fréquence choisie n’est pas reconnue.");
  }

  const schedule: HumanSchedule = {
    cadence: cadence as ScheduleCadence,
    hour: integer(value["hour"], "L’heure", 0, 23),
    minute: integer(value["minute"], "Les minutes", 0, 59),
  };
  if (schedule.cadence === "weekly") {
    schedule.weekday = integer(value["weekday"], "Le jour de la semaine", 0, 6);
  }
  if (schedule.cadence === "monthly") {
    schedule.monthday = integer(value["monthday"], "Le jour du mois", 1, 28);
  }
  return schedule;
}

export function scheduleToCron(input: unknown): string {
  const schedule = normalizeHumanSchedule(input);
  const prefix = `${schedule.minute} ${schedule.hour}`;
  if (schedule.cadence === "daily") return `${prefix} * * *`;
  if (schedule.cadence === "weekdays") return `${prefix} * * 1-5`;
  if (schedule.cadence === "weekly") return `${prefix} * * ${schedule.weekday}`;
  return `${prefix} ${schedule.monthday} * *`;
}

export function cronToSchedule(cron: string): HumanSchedule | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteRaw, hourRaw, monthday, month, weekday] = fields;
  if (!/^\d+$/.test(minuteRaw!) || !/^\d+$/.test(hourRaw!)) return null;
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (month !== "*") return null;

  if (monthday === "*" && weekday === "*") return { cadence: "daily", hour, minute };
  if (monthday === "*" && weekday === "1-5") return { cadence: "weekdays", hour, minute };
  if (monthday === "*" && /^[0-6]$/.test(weekday!)) {
    return { cadence: "weekly", hour, minute, weekday: Number(weekday) };
  }
  if (/^\d+$/.test(monthday!) && weekday === "*") {
    const day = Number(monthday);
    if (day >= 1 && day <= 28) return { cadence: "monthly", hour, minute, monthday: day };
  }
  return null;
}

function timeLabel(schedule: HumanSchedule): string {
  return `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} UTC`;
}

export function scheduleLabel(schedule: HumanSchedule | null): string {
  if (!schedule) return "Programmation avancée";
  const at = timeLabel(schedule);
  if (schedule.cadence === "daily") return `Tous les jours à ${at}`;
  if (schedule.cadence === "weekdays") return `Du lundi au vendredi à ${at}`;
  if (schedule.cadence === "weekly") return `Chaque ${WEEKDAYS[schedule.weekday ?? 1]} à ${at}`;
  return `Le ${schedule.monthday} de chaque mois à ${at}`;
}

