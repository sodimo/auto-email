import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SmtpError } from "../vendor/worker-mailer/index.js";
import { drainOutbox } from "../src/lib/drain.js";
import { enqueueDueJobs, runJobById } from "../src/runner.js";
import { addRecipient, FakeTransport, insertJob, outbox, sendLog, setSetting } from "./helpers.js";

const TICK = new Date("2026-07-29T06:00:00Z").getTime();
const noAppender = async () => null;

async function seedInvoices(rows: [string, string, number, number][]): Promise<void> {
  for (const [numero, client, montant, jours] of rows) {
    await env.DB.prepare("INSERT INTO test_invoices (numero, client, montant, jours) VALUES (?, ?, ?, ?)")
      .bind(numero, client, montant, jours)
      .run();
  }
}

async function firstQueuedBody(): Promise<string> {
  const row = await env.DB.prepare("SELECT body_html FROM outbox ORDER BY id LIMIT 1").first<{
    body_html: string;
  }>();
  return row!.body_html;
}

describe("enqueueDueJobs", () => {
  it("queues a job whose schedule fired in the tick window, and no others", async () => {
    await insertJob({ name: "due", schedule: "0 6 * * *" });
    await insertJob({ name: "not-due", schedule: "0 7 * * *" });
    await insertJob({ name: "disabled", schedule: "0 6 * * *", enabled: 0 });

    const summary = await enqueueDueJobs(env, TICK);

    expect(summary.jobs.map((j) => j.job)).toEqual(["due"]);
    expect(summary.jobs[0]).toMatchObject({ attempted: 2, queued: 2, failed: 0 });
    expect((await outbox()).map((r) => r.recipient).sort()).toEqual([
      "paul.ghafary@sodimo.eu",
      "thomas@leger.run",
    ]);
  });

  it("touches no SMTP at all — sending is the drain's job", async () => {
    await insertJob({ name: "due", schedule: "0 6 * * *" });
    await enqueueDueJobs(env, TICK);

    expect((await outbox()).every((r) => r.status === "pending")).toBe(true);
    expect((await sendLog()).every((r) => r.status === "pending")).toBe(true);
  });

  it("stops before loading any job when the kill switch is engaged", async () => {
    await insertJob({ name: "due", schedule: "0 6 * * *" });
    await setSetting("kill_switch", "on");

    const summary = await enqueueDueJobs(env, TICK);

    expect(summary.suppressed).toContain("kill switch engaged");
    expect(summary.jobs).toEqual([]);
    expect(await outbox()).toEqual([]);
    expect(await sendLog()).toEqual([]);
  });

  it("reports a malformed schedule instead of silently never firing", async () => {
    await insertJob({ name: "broken", schedule: "@daily" });
    const summary = await enqueueDueJobs(env, TICK);
    expect(summary.jobs).toEqual([]);
    expect(summary.skipped).toEqual([{ job: "broken", reason: expect.stringContaining("5 cron fields") }]);
  });

  it("is idempotent across ticks in the same day for a per_day job", async () => {
    await insertJob({ name: "nightly", schedule: "* * * * *", dedupe_strategy: "per_day" });

    await enqueueDueJobs(env, TICK);
    await enqueueDueJobs(env, TICK + 5 * 60_000);

    expect(await outbox()).toHaveLength(2); // two recipients, once each
  });

  it("logs an unpinned list member as skipped without dropping the pinned ones", async () => {
    await addRecipient("rani@sodimo.eu", "Rani");
    await insertJob({ name: "due", schedule: "0 6 * * *" });

    const summary = await enqueueDueJobs(env, TICK);

    expect(summary.jobs[0]).toMatchObject({ attempted: 3, queued: 2, skipped: 1 });
    expect((await outbox()).map((r) => r.recipient)).not.toContain("rani@sodimo.eu");
    expect((await sendLog()).find((r) => r.recipient === "rani@sodimo.eu")?.status).toBe("skipped_test_mode");
  });
});

describe("digest jobs", () => {
  it("queues even with nothing to report", async () => {
    await insertJob({ name: "digest", kind: "digest", schedule: "0 6 * * *" });
    await enqueueDueJobs(env, TICK);

    const queued = await outbox();
    expect(queued).toHaveLength(2);
    expect(queued[0]!.subject).toBe("Rapport quotidien Sodimo — mercredi 29 juillet 2026");
    expect(await firstQueuedBody()).toContain("Aucune donnée à signaler");
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

    const summary = await enqueueDueJobs(env, TICK);

    expect(summary.jobs[0]).toMatchObject({ rowCount: 2, queued: 2 });
    expect(await outbox()).toHaveLength(2); // one message per recipient, not per row
    const body = await firstQueuedBody();
    expect(body).toContain("F-1001");
    expect(body).toContain("F-1002");
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

  it("queues nothing when the condition matches no rows", async () => {
    await seedInvoices([["F-2001", "Acme", 100, 5]]);
    await insertJob(overdue);

    const summary = await enqueueDueJobs(env, TICK);

    expect(summary.jobs[0]).toMatchObject({ rowCount: 0, attempted: 0 });
    expect(await outbox()).toEqual([]);
    expect(await sendLog()).toEqual([]);
  });

  it("queues one alert per matched row and exposes its columns to the template", async () => {
    await seedInvoices([
      ["F-3001", "Acme", 1250.5, 31],
      ["F-3002", "Bordeaux Co", 900, 45],
      ["F-3003", "Paid Co", 10, 2],
    ]);
    await insertJob(overdue);

    const summary = await enqueueDueJobs(env, TICK);

    expect(summary.jobs[0]).toMatchObject({ rowCount: 2, attempted: 4, queued: 4 });
    expect(summary.jobs[0]!.dedupeKeys).toEqual(["row:F-3001", "row:F-3002"]);
    expect(await outbox()).toHaveLength(4); // 2 rows x 2 recipients
    const body = await firstQueuedBody();
    expect(body).toContain("F-3001");
    expect(body).not.toContain("F-3002");
  });

  it("alerts once per row, ever — a new row later does not requeue the old one", async () => {
    await seedInvoices([["F-4001", "Acme", 100, 31]]);
    await insertJob(overdue);

    await enqueueDueJobs(env, TICK);
    expect(await outbox()).toHaveLength(2);

    await seedInvoices([["F-4002", "Bordeaux Co", 200, 40]]);
    const summary = await enqueueDueJobs(env, TICK + 24 * 3600_000);

    expect(summary.jobs[0]).toMatchObject({ rowCount: 2, queued: 2, duplicates: 2 });
    expect(await outbox()).toHaveLength(4);
  });

  it("refuses condition_sql that is not a single read-only statement", async () => {
    await insertJob({ ...overdue, condition_sql: "DELETE FROM test_invoices" });
    const summary = await enqueueDueJobs(env, TICK);
    expect(summary.jobs).toEqual([]);
    expect(summary.skipped[0]!.reason).toContain("must start with SELECT or WITH");
  });

  it("refuses per_row without a dedupe_key column", async () => {
    await seedInvoices([["F-5001", "Acme", 100, 31]]);
    await insertJob({ ...overdue, condition_sql: "SELECT numero FROM test_invoices" });
    const summary = await enqueueDueJobs(env, TICK);
    expect(summary.skipped[0]!.reason).toContain("dedupe_key");
  });
});

describe("manual triggers", () => {
  it("share the enqueue path but never collide with the scheduled slot", async () => {
    await insertJob({ name: "nightly", schedule: "0 6 * * *", dedupe_strategy: "per_day" });

    await enqueueDueJobs(env, TICK);
    const manual = await runJobById(env, "nightly");

    expect(manual.result).toMatchObject({ queued: 2, duplicates: 0 });
    expect(manual.result!.dedupeKeys[0]).toMatch(/^manual:/);
    expect(await outbox()).toHaveLength(4);
  });

  it("run a disabled job — that is what the button is for", async () => {
    await insertJob({ name: "off", schedule: "0 6 * * *", enabled: 0 });
    const manual = await runJobById(env, "off");
    expect(manual.result).toMatchObject({ queued: 2 });
  });

  it("obey the kill switch", async () => {
    await insertJob({ name: "off", schedule: "0 6 * * *" });
    await setSetting("kill_switch", "on");
    const manual = await runJobById(env, "off");
    expect(manual.suppressed).toContain("kill switch");
    expect(await outbox()).toEqual([]);
  });
});

describe("enqueue then drain, end to end", () => {
  it("delivers the nightly digest to both pinned addresses", async () => {
    await insertJob({ name: "nightly", schedule: "0 6 * * *", dedupe_strategy: "per_day" });
    const transport = new FakeTransport();

    await enqueueDueJobs(env, TICK);
    const drained = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(drained).toMatchObject({ scanned: 2, sent: 2 });
    expect(transport.recipients.sort()).toEqual([
      "paul.ghafary@sodimo.eu",
      "thomas@leger.run",
    ]);
    expect(transport.sent[0]!.raw).toContain("From: \"Rapports Sodimo\" <rapports@sodimo.eu>");
    expect((await sendLog()).every((r) => r.status === "sent")).toBe(true);
  });

  it("does not let one bad recipient cost the rest of the batch", async () => {
    await insertJob({ name: "nightly", schedule: "0 6 * * *" });
    const transport = new FakeTransport((to) =>
      to === "thomas@leger.run" ? new SmtpError("rcpt", "550 unknown", "550 5.1.1 unknown\r\n") : undefined,
    );

    await enqueueDueJobs(env, TICK);
    const drained = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(drained).toMatchObject({ scanned: 2, sent: 1, failed: 1 });
    expect(transport.recipients).toEqual(["paul.ghafary@sodimo.eu"]);
    const log = await sendLog();
    expect(log.find((r) => r.recipient === "thomas@leger.run")!.status).toBe("failed");
    expect(log.find((r) => r.recipient === "paul.ghafary@sodimo.eu")!.status).toBe("sent");
  });
});
