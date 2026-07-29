import { describe, expect, it } from "vitest";
import { CronError, dueSlots, isoMinute, matchesCron, parseCron } from "../src/lib/cron.js";

const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("expands wildcards, singletons, ranges and steps", () => {
    const c = parseCron("0,30 9-17/4 * * *");
    expect([...c.minute]).toEqual([0, 30]);
    expect([...c.hour]).toEqual([9, 13, 17]);
    expect(c.dom.size).toBe(31);
    expect(c.month.size).toBe(12);
  });

  it("normalises day-of-week 7 to Sunday", () => {
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
    expect(matchesCron("0 0 * * 7", at("2026-08-02T00:00:00Z"))).toBe(true); // a Sunday
  });

  it("rejects everything outside the documented subset", () => {
    for (const expr of [
      "@daily",
      "0 0 * JAN *",
      "0 0 * * MON",
      "60 * * * *",
      "* 24 * * *",
      "0 0 0 * *",
      "*/0 * * * *",
      "5/2 * * * *", // a step needs * or a range
      "0 0 * *", // four fields
      "0 0 * * * *", // six fields
      "0 0 13L * *",
      "10-5 * * * *",
    ]) {
      expect(() => parseCron(expr), expr).toThrow(CronError);
    }
  });
});

describe("matchesCron", () => {
  it("matches the nightly digest slot and nothing adjacent", () => {
    expect(matchesCron("0 6 * * *", at("2026-07-29T06:00:00Z"))).toBe(true);
    expect(matchesCron("0 6 * * *", at("2026-07-29T06:01:00Z"))).toBe(false);
    expect(matchesCron("0 6 * * *", at("2026-07-29T05:00:00Z"))).toBe(false);
  });

  it("ANDs day-of-month and day-of-week when only one is restricted", () => {
    // Wednesdays only; the 29th happens to be one, the 30th is not.
    expect(matchesCron("0 6 * * 3", at("2026-07-29T06:00:00Z"))).toBe(true);
    expect(matchesCron("0 6 * * 3", at("2026-07-30T06:00:00Z"))).toBe(false);
  });

  it("ORs them when BOTH are restricted (vixie-cron rule)", () => {
    const friday13th = "0 0 13 * 5";
    expect(matchesCron(friday13th, at("2026-11-13T00:00:00Z"))).toBe(true); // Friday AND 13th
    expect(matchesCron(friday13th, at("2026-11-06T00:00:00Z"))).toBe(true); // Friday, not 13th
    expect(matchesCron(friday13th, at("2026-10-13T00:00:00Z"))).toBe(true); // 13th, a Tuesday
    expect(matchesCron(friday13th, at("2026-11-07T00:00:00Z"))).toBe(false); // neither
  });

  it("is UTC, not local", () => {
    expect(matchesCron("0 6 * * *", at("2026-07-29T06:00:00Z"))).toBe(true);
    expect(matchesCron("0 8 * * *", at("2026-07-29T06:00:00Z"))).toBe(false);
  });
});

describe("dueSlots", () => {
  const tick = (iso: string) => at(iso).getTime();

  it("finds a slot that does not align to the tick boundary", () => {
    // The 06:05 tick covers 06:01-06:05, so a 06:03 job still fires.
    expect(dueSlots("3 6 * * *", tick("2026-07-29T06:05:00Z"), 5)).toEqual(["2026-07-29T06:03Z"]);
    expect(dueSlots("3 6 * * *", tick("2026-07-29T06:10:00Z"), 5)).toEqual([]);
  });

  it("partitions the timeline — consecutive ticks never share a slot", () => {
    const first = dueSlots("* * * * *", tick("2026-07-29T06:05:00Z"), 5);
    const second = dueSlots("* * * * *", tick("2026-07-29T06:10:00Z"), 5);
    expect(first).toEqual([
      "2026-07-29T06:01Z",
      "2026-07-29T06:02Z",
      "2026-07-29T06:03Z",
      "2026-07-29T06:04Z",
      "2026-07-29T06:05Z",
    ]);
    expect(second[0]).toBe("2026-07-29T06:06Z");
    expect(first.filter((s) => second.includes(s))).toEqual([]);
  });

  it("includes the tick minute itself and ignores sub-minute drift", () => {
    expect(dueSlots("0 6 * * *", tick("2026-07-29T06:00:41Z"), 5)).toEqual(["2026-07-29T06:00Z"]);
  });

  it("propagates parse errors so a broken schedule is loud, not silent", () => {
    expect(() => dueSlots("@daily", tick("2026-07-29T06:00:00Z"), 5)).toThrow(CronError);
  });
});

describe("isoMinute", () => {
  it("identifies a one-minute slot", () => {
    expect(isoMinute(at("2026-07-29T06:03:59Z"))).toBe("2026-07-29T06:03Z");
  });
});
