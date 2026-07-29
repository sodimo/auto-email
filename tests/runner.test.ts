import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runDueJobs, runJobById } from "../src/runner.js";
import { addRecipient, FakeMailer, insertJob, sendLog, setSetting } from "./helpers.js";

const TICK = new Date("2026-07-29T06:00:00Z").getTime();
const mailerFactory = (mailer: FakeMailer) => () => mailer;

async function seedInvoices(rows: [string, string, number, number][]): Promise<void> {
  for (const [numero, client, montant, jours] of rows) {
    await env.DB.prepare("INSERT INTO test_invoices (numero, client, montant, jours) VALUES (?, ?, ?, ?)")
      .bind(numero, client, montant, jours)
      .run();
  }
}

describe("runDueJobs", () => {
  it("runs a job whose schedule fired in the tick window, and no others", async () => {
    await insertJob({ name: "due", schedule: "0 6 * * *" });
    await insertJob({ name: "not-due", schedule: "0 7 * * *" });
    await insertJob({ name: "disabled", schedule: "0 6 * * *", enabled: 0 });

    const mailer = new FakeMailer();
    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.jobs.map((j) => j.job)).toEqual(["due"]);
    expect(summary.jobs[0]).toMatchObject({ attempted: 2, sent: 2, failed: 0 });
    expect(mailer.recipients.sort()).toEqual(["thomas@leger.run", "tombionic@gmail.com"]);
  });

  it("stops before loading any job when the kill switch is engaged", async () => {
    await insertJob({ name: "due", schedule: "0 6 * * *" });
    await setSetting("kill_switch", "on");

    const mailer = new FakeMailer();
    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.suppressed).toContain("kill switch engaged");
    expect(summary.jobs).toEqual([]);
    expect(mailer.sent).toHaveLength(0);
    expect(await sendLog()).toEqual([]);
  });

  it("reports a malformed schedule instead of silently never firing", async () => {
    await insertJob({ name: "broken", schedule: "@daily" });
    const summary = await runDueJobs(env, TICK, mailerFactory(new FakeMailer()));
    expect(summary.jobs).toEqual([]);
    expect(summary.skipped).toEqual([{ job: "broken", reason: expect.stringContaining("5 cron fields") }]);
  });

  it("is idempotent across ticks in the same day for a per_day job", async () => {
    await insertJob({ name: "nightly", schedule: "* * * * *", dedupe_strategy: "per_day" });
    const mailer = new FakeMailer();

    await runDueJobs(env, TICK, mailerFactory(mailer));
    await runDueJobs(env, TICK + 5 * 60_000, mailerFactory(mailer));

    expect(mailer.sent).toHaveLength(2); // two recipients, once each
    expect(await sendLog()).toHaveLength(2);
  });

  it("does not let one bad recipient abort the run", async () => {
    await insertJob({ name: "due", schedule: "0 6 * * *" });
    const mailer = new FakeMailer((m) =>
      m.to.email === "thomas@leger.run" ? new Error("421 service unavailable") : undefined,
    );

    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.jobs[0]).toMatchObject({ attempted: 2, sent: 1, failed: 1 });
    expect(summary.jobs[0]!.errors[0]).toContain("421 service unavailable");
    expect(mailer.recipients).toEqual(["tombionic@gmail.com"]);
  });

  it("logs an unpinned list member as skipped without dropping the pinned ones", async () => {
    await addRecipient("rani@sodimo.eu", "Rani");
    await insertJob({ name: "due", schedule: "0 6 * * *" });

    const mailer = new FakeMailer();
    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.jobs[0]).toMatchObject({ attempted: 3, sent: 2, skipped: 1 });
    expect(mailer.recipients).not.toContain("rani@sodimo.eu");
    const skipped = (await sendLog()).find((r) => r.recipient === "rani@sodimo.eu");
    expect(skipped?.status).toBe("skipped_test_mode");
  });
});

describe("digest jobs", () => {
  it("sends even with nothing to report", async () => {
    await insertJob({ name: "digest", kind: "digest", schedule: "0 6 * * *" });
    const mailer = new FakeMailer();
    await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(mailer.sent).toHaveLength(2);
    expect(mailer.sent[0]!.html).toContain("Aucune donnée à signaler");
    expect(mailer.sent[0]!.subject).toBe("Rapport quotidien Sodimo — mercredi 29 juillet 2026");
  });

  it("puts every matched row in ONE message", async () => {
    await seedInvoices([
      ["F-1001", "Acme", 1250.5, 31],
      ["F-1002", "Bordeaux Co", 900, 45],
    ]);
    await insertJob({
      name: "digest",
      kind: "digest",
      schedule: "0 6 * * *",
      condition_sql: "SELECT numero, client, montant FROM test_invoices ORDER BY numero",
    });

    const mailer = new FakeMailer();
    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.jobs[0]).toMatchObject({ rowCount: 2, sent: 2 });
    expect(mailer.sent).toHaveLength(2); // one message per recipient, not per row
    expect(mailer.sent[0]!.html).toContain("F-1001");
    expect(mailer.sent[0]!.html).toContain("F-1002");
  });
});

describe("condition jobs", () => {
  const overdue = {
    name: "impayes",
    kind: "condition" as const,
    schedule: "0 6 * * *",
    dedupe_strategy: "per_row" as const,
    condition_sql:
      "SELECT numero AS dedupe_key, numero, client, montant FROM test_invoices WHERE jours >= 30 ORDER BY numero",
  };

  it("sends nothing when the condition matches no rows", async () => {
    await seedInvoices([["F-2001", "Acme", 100, 5]]);
    await insertJob(overdue);

    const mailer = new FakeMailer();
    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.jobs[0]).toMatchObject({ rowCount: 0, attempted: 0 });
    expect(mailer.sent).toHaveLength(0);
    expect(await sendLog()).toEqual([]);
  });

  it("sends one alert per matched row and exposes its columns to the template", async () => {
    await seedInvoices([
      ["F-3001", "Acme", 1250.5, 31],
      ["F-3002", "Bordeaux Co", 900, 45],
      ["F-3003", "Paid Co", 10, 2],
    ]);
    await insertJob(overdue);

    const mailer = new FakeMailer();
    const summary = await runDueJobs(env, TICK, mailerFactory(mailer));

    expect(summary.jobs[0]).toMatchObject({ rowCount: 2, attempted: 4, sent: 4 });
    expect(summary.jobs[0]!.dedupeKeys).toEqual(["row:F-3001", "row:F-3002"]);
    expect(mailer.sent).toHaveLength(4); // 2 rows x 2 recipients
    expect(mailer.sent[0]!.html).toContain("F-3001");
    expect(mailer.sent[0]!.html).not.toContain("F-3002");
  });

  it("alerts once per row, ever — a new row on the next run does not resend the old one", async () => {
    await seedInvoices([["F-4001", "Acme", 100, 31]]);
    await insertJob(overdue);
    const mailer = new FakeMailer();

    await runDueJobs(env, TICK, mailerFactory(mailer));
    expect(mailer.sent).toHaveLength(2);

    await seedInvoices([["F-4002", "Bordeaux Co", 200, 40]]);
    const summary = await runDueJobs(env, TICK + 24 * 3600_000, mailerFactory(mailer));

    expect(summary.jobs[0]).toMatchObject({ rowCount: 2, sent: 2, duplicates: 2 });
    expect(mailer.recipients.filter((r) => r)).toHaveLength(4);
    expect(mailer.sent.slice(2).every((m) => m.html.includes("F-4002"))).toBe(true);
  });

  it("refuses condition_sql that is not a single read-only statement", async () => {
    await insertJob({ ...overdue, condition_sql: "DELETE FROM test_invoices" });
    const summary = await runDueJobs(env, TICK, mailerFactory(new FakeMailer()));
    expect(summary.jobs).toEqual([]);
    expect(summary.skipped[0]!.reason).toContain("must start with SELECT or WITH");
  });

  it("refuses per_row without a dedupe_key column", async () => {
    await seedInvoices([["F-5001", "Acme", 100, 31]]);
    await insertJob({ ...overdue, condition_sql: "SELECT numero FROM test_invoices" });
    const summary = await runDueJobs(env, TICK, mailerFactory(new FakeMailer()));
    expect(summary.skipped[0]!.reason).toContain("dedupe_key");
  });
});

describe("manual triggers", () => {
  it("share the send path but never collide with the scheduled slot", async () => {
    await insertJob({ name: "nightly", schedule: "0 6 * * *", dedupe_strategy: "per_day" });
    const mailer = new FakeMailer();

    await runDueJobs(env, TICK, mailerFactory(mailer));
    const manual = await runJobById(env, "nightly", mailerFactory(mailer));

    expect(manual.result).toMatchObject({ sent: 2, duplicates: 0 });
    expect(manual.result!.dedupeKeys[0]).toMatch(/^manual:/);
    expect(mailer.sent).toHaveLength(4);
  });

  it("run a disabled job — that is what the button is for", async () => {
    await insertJob({ name: "off", schedule: "0 6 * * *", enabled: 0 });
    const manual = await runJobById(env, "off", mailerFactory(new FakeMailer()));
    expect(manual.result).toMatchObject({ sent: 2 });
  });

  it("obey the kill switch", async () => {
    await insertJob({ name: "off", schedule: "0 6 * * *" });
    await setSetting("kill_switch", "on");
    const mailer = new FakeMailer();
    const manual = await runJobById(env, "off", mailerFactory(mailer));
    expect(manual.suppressed).toContain("kill switch");
    expect(mailer.sent).toHaveLength(0);
  });
});
