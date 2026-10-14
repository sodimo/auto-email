import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SmtpError } from "../vendor/worker-mailer/index.js";
import { MAX_SEND_ATTEMPTS } from "../src/config.js";
import { backoffMinutes, batchSize, drainOutbox } from "../src/lib/drain.js";
import { enqueue } from "../src/lib/enqueue.js";
import { smtpConfigFromSettings } from "../src/lib/mailer.js";
import type { Job } from "../src/types.js";
import {
  addRecipient,
  FakeAppender,
  FakeTransport,
  insertJob,
  makeQueueDue,
  outbox,
  sendLog,
  setSetting,
  settingsOf,
  UnreachableTransport,
} from "./helpers.js";

let job: Job;
beforeEach(async () => {
  job = await insertJob({ name: "drain-test" });
});

/** Queues `count` messages to the handoff address, one per dedupe key. */
async function queueMessages(count: number): Promise<void> {
  const settings = await settingsOf();
  for (let i = 0; i < count; i++) {
    const outcome = await enqueue({
      db: env.DB,
      settings,
      job,
      recipient: { email: "paul.ghafary@sodimo.eu", display_name: "Paul" },
      dedupeKey: `run:key-${i}`,
      subject: `Rapport ${i}`,
      html: `<p>Rapport ${i}</p>`,
      text: `Rapport ${i}`,
    });
    if (outcome.result !== "queued") throw new Error(`could not queue: ${JSON.stringify(outcome)}`);
  }
}

const noAppender = async () => null;

describe("draining", () => {
  it("sends the queue and settles both tables", async () => {
    await queueMessages(2);
    const transport = new FakeTransport();

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary).toMatchObject({ scanned: 2, sent: 2, failed: 0, retrying: 0 });
    expect(transport.recipients).toEqual(["paul.ghafary@sodimo.eu", "paul.ghafary@sodimo.eu"]);
    expect((await outbox()).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect((await sendLog()).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect((await sendLog())[0]!.smtp_response).toContain("250");
  });

  it("opens ONE SMTP session for the whole batch and closes it", async () => {
    await queueMessages(5);
    const transport = new FakeTransport();

    await drainOutbox(env, { transport, openAppender: noAppender });

    expect(transport.opens).toBe(1);
    expect(transport.closes).toBe(1);
  });

  it("respects the batch limit and leaves the rest queued", async () => {
    await queueMessages(5);
    await setSetting("drain_batch_size", "2");
    const transport = new FakeTransport();

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary).toMatchObject({ scanned: 2, sent: 2 });
    const statuses = (await outbox()).map((r) => r.status);
    expect(statuses).toEqual(["sent", "sent", "pending", "pending", "pending"]);
  });

  it("clamps a reckless batch size and falls back on nonsense", () => {
    expect(batchSize({ drain_batch_size: "3" })).toBe(3);
    expect(batchSize({ drain_batch_size: "1000" })).toBe(25);
    expect(batchSize({ drain_batch_size: "zero" })).toBe(10);
    expect(batchSize({})).toBe(10);
    expect(batchSize({ drain_batch_size: "3" }, 1)).toBe(1);
  });

  it("is idempotent under re-run — a drained message is not re-sent", async () => {
    await queueMessages(2);
    const transport = new FakeTransport();

    await drainOutbox(env, { transport, openAppender: noAppender });
    const second = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(second).toMatchObject({ scanned: 0, sent: 0 });
    expect(transport.sent).toHaveLength(2);
  });

  it("does nothing when the queue is empty, not even opening a session", async () => {
    const transport = new FakeTransport();
    const summary = await drainOutbox(env, { transport, openAppender: noAppender });
    expect(summary.scanned).toBe(0);
    expect(transport.opens).toBe(0);
  });
});

describe("retry and backoff", () => {
  const transient = () => new SmtpError("mail", "451 try later", "451 4.3.2 mailbox busy\r\n");

  it("re-queues a provably-undelivered failure with a growing delay", async () => {
    await queueMessages(1);
    const transport = new FakeTransport(transient);

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary).toMatchObject({ sent: 0, failed: 0, retrying: 1 });
    const [row] = await outbox();
    expect(row).toMatchObject({ status: "pending", attempts: 1 });
    expect(row!.last_error).toContain("451");
    // Still pending in the ledger: the message has not failed, only waited.
    expect((await sendLog())[0]!.status).toBe("pending");
    // Backoff pushed it into the future, so the next tick skips it.
    const skipped = await drainOutbox(env, { transport, openAppender: noAppender });
    expect(skipped.scanned).toBe(0);
  });

  it("steps the delay up and stops after the last attempt", () => {
    expect(backoffMinutes(1)).toBe(5);
    expect(backoffMinutes(2)).toBe(15);
    expect(backoffMinutes(3)).toBe(60);
    expect(backoffMinutes(99)).toBe(60);
  });

  it("gives up once the attempt budget is spent", async () => {
    await queueMessages(1);
    const transport = new FakeTransport(transient);

    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      await makeQueueDue();
      await drainOutbox(env, { transport, openAppender: noAppender });
    }

    expect((await outbox())[0]).toMatchObject({ status: "failed", attempts: MAX_SEND_ATTEMPTS });
    expect((await sendLog())[0]!.status).toBe("failed");
  });

  it("NEVER retries a failure whose delivery cannot be ruled out", async () => {
    await queueMessages(1);
    // No response at all after the body was flushed: the mail may have landed.
    const transport = new FakeTransport(() => new SmtpError("body", "timed out waiting for the response"));

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary).toMatchObject({ sent: 0, failed: 1, retrying: 0 });
    expect((await outbox())[0]!.status).toBe("failed");
    expect((await sendLog())[0]!.status).toBe("failed");
  });

  it("treats a plain error as terminal — only the SMTP client may claim retryability", async () => {
    await queueMessages(1);
    const transport = new FakeTransport(() => new Error("something went wrong"));

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });
    expect(summary).toMatchObject({ failed: 1, retrying: 0 });
  });

  it("charges no attempt when the session itself cannot be opened", async () => {
    await queueMessages(2);

    const summary = await drainOutbox(env, { transport: new UnreachableTransport(), openAppender: noAppender });

    expect(summary.errors[0]).toContain("SMTP session unavailable");
    expect((await outbox()).every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
  });
});

describe("the guard runs again at drain time", () => {
  it("holds the queue while the kill switch is engaged, cancelling nothing", async () => {
    await queueMessages(2);
    await setSetting("kill_switch", "on");
    const transport = new FakeTransport();

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary.suppressed).toContain("kill switch");
    expect(transport.opens).toBe(0);
    expect((await outbox()).every((r) => r.status === "pending")).toBe(true);

    // Turning it back off resumes exactly where it stopped.
    await setSetting("kill_switch", "off");
    expect(await drainOutbox(env, { transport, openAppender: noAppender })).toMatchObject({ sent: 2 });
  });

  it("cancels a queued message whose recipient is no longer allowed", async () => {
    await queueMessages(1);
    // Simulates a row queued before the allowlist tightened.
    await env.DB.prepare("UPDATE outbox SET recipient = 'rani@sodimo.eu'").run();
    await addRecipient("rani@sodimo.eu", "Rani");
    await setSetting("test_mode", "on");
    const transport = new FakeTransport();

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary).toMatchObject({ cancelled: 1, sent: 0 });
    expect(transport.sent).toHaveLength(0);
    expect((await outbox())[0]!.status).toBe("cancelled");
    expect((await sendLog())[0]!.status).toBe("skipped_test_mode");
  });

  it("cancels a queued message after the UI recipient is paused", async () => {
    await queueMessages(1);
    await env.DB.prepare(
      "UPDATE recipient_list_members SET active = 0 WHERE lower(email) = 'paul.ghafary@sodimo.eu'",
    ).run();
    const transport = new FakeTransport();

    const summary = await drainOutbox(env, { transport, openAppender: noAppender });

    expect(summary).toMatchObject({ cancelled: 1, sent: 0 });
    expect(transport.opens).toBe(0);
    expect((await outbox())[0]).toMatchObject({
      status: "cancelled",
      last_error: "recipient is no longer active in the job's selected list",
    });
    expect((await sendLog())[0]).toMatchObject({
      status: "suppressed",
      smtp_response: "recipient is no longer active in the job's selected list",
    });
  });
});

describe("Sent-folder copies", () => {
  it("appends the SAME bytes that went over SMTP and logs the APPENDUID", async () => {
    await queueMessages(1);
    const transport = new FakeTransport();
    const appender = new FakeAppender();

    const summary = await drainOutbox(env, { transport, openAppender: async () => appender });

    expect(summary).toMatchObject({ sent: 1, appended: 1, appendFailed: 0 });
    // One message, built once, used by both paths.
    expect(appender.appended).toEqual([transport.sent[0]!.raw]);
    expect((await sendLog())[0]).toMatchObject({
      status: "sent",
      append_status: "appended",
      append_response: "a3 OK [APPENDUID 1 42] APPEND completed",
    });
    expect(appender.closes).toBe(1);
  });

  it("opens ONE IMAP session for the batch", async () => {
    await queueMessages(3);
    const appender = new FakeAppender();
    let opened = 0;

    await drainOutbox(env, {
      transport: new FakeTransport(),
      openAppender: async () => {
        opened++;
        return appender;
      },
    });

    expect(opened).toBe(1);
    expect(appender.appended).toHaveLength(3);
  });

  it("still counts the email as SENT when the copy fails", async () => {
    await queueMessages(1);
    const summary = await drainOutbox(env, {
      transport: new FakeTransport(),
      openAppender: async () => new FakeAppender(true),
    });

    expect(summary).toMatchObject({ sent: 1, appended: 0, appendFailed: 1, failed: 0 });
    expect((await sendLog())[0]).toMatchObject({ status: "sent", append_status: "failed" });
  });

  it("still counts the email as SENT when IMAP cannot be reached at all", async () => {
    await queueMessages(1);
    const summary = await drainOutbox(env, {
      transport: new FakeTransport(),
      openAppender: async () => {
        throw new Error("imap.strato.com unreachable");
      },
    });

    expect(summary).toMatchObject({ sent: 1, appendFailed: 1, failed: 0 });
    expect((await sendLog())[0]).toMatchObject({ status: "sent", append_status: "failed" });
    expect((await sendLog())[0]!.append_response).toContain("unreachable");
  });

  it("records 'skipped' when Sent copies are turned off", async () => {
    await queueMessages(1);
    await setSetting("imap_append", "off");

    const summary = await drainOutbox(env, { transport: new FakeTransport() });

    expect(summary).toMatchObject({ sent: 1, appended: 0, appendFailed: 0 });
    expect((await sendLog())[0]).toMatchObject({ status: "sent", append_status: "skipped" });
  });
});

describe("sender identity", () => {
  it("authenticates and bounces as the From address by default", async () => {
    const settings = await settingsOf();
    const config = smtpConfigFromSettings(settings, env);
    expect(config.username).toBe("rapports@sodimo.eu");
  });

  it("can authenticate as one mailbox and show another as From", async () => {
    // The first live test: is `From: facturation@` over `rapports@` credentials
    // accepted by Strato? If not, the fallback is reply_to, below.
    await setSetting("from_address", "facturation@sodimo.eu");
    await setSetting("smtp_username", "rapports@sodimo.eu");

    const config = smtpConfigFromSettings(await settingsOf(), env);
    expect(config.username).toBe("rapports@sodimo.eu");

    await queueMessages(1);
    const transport = new FakeTransport();
    await drainOutbox(env, { transport, openAppender: noAppender });

    expect(transport.sent[0]!.raw).toContain("From: \"Rapports Sodimo\" <facturation@sodimo.eu>");
  });

  it("points replies wherever reply_to says", async () => {
    await setSetting("reply_to", "facturation@sodimo.eu");
    await queueMessages(1);
    const transport = new FakeTransport();

    await drainOutbox(env, { transport, openAppender: noAppender });

    expect(transport.sent[0]!.raw).toContain("Reply-To: facturation@sodimo.eu");
  });

  it("defaults Reply-To to the From address", async () => {
    await queueMessages(1);
    const transport = new FakeTransport();

    await drainOutbox(env, { transport, openAppender: noAppender });

    expect(transport.sent[0]!.raw).toContain("Reply-To: rapports@sodimo.eu");
  });
});

describe("D1 refusing writes (daily row-write limit or outage)", () => {
  const QUOTA = "D1_ERROR: Exceeded D1's free tier daily row write limit";

  /** env.DB, except that statements matching `match` fail on run(). */
  function refusing(match: (sql: string) => boolean, refuseBatch = false): D1Database {
    const db = env.DB;
    const wrap = <T extends object>(target: T, override: Record<string, unknown>): T =>
      new Proxy(target, {
        get(t, prop) {
          if (typeof prop === "string" && prop in override) return override[prop];
          const value = Reflect.get(t, prop);
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    return wrap(db, {
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!match(sql)) return statement;
        return wrap(statement, {
          bind: (...args: unknown[]) =>
            wrap(statement.bind(...args), { run: async () => { throw new Error(QUOTA); } }),
        });
      },
      ...(refuseBatch ? { batch: async () => { throw new Error(QUOTA); } } : {}),
    });
  }

  it("sends nothing when the pre-send write is refused, and leaves the queue due", async () => {
    await queueMessages(2);
    const transport = new FakeTransport();
    const DB = refusing((sql) => sql.includes("SET next_attempt_at = '9999"));

    const summary = await drainOutbox({ ...env, DB }, { transport, openAppender: noAppender });

    expect(transport.sent).toHaveLength(0);
    expect(summary.sent).toBe(0);
    expect(summary.errors[0]).toContain("pre-send write");
    expect((await outbox()).map((r) => r.status)).toEqual(["pending", "pending"]);
    const retry = await drainOutbox(env, { transport, openAppender: noAppender });
    expect(retry.sent).toBe(2);
  });

  it("never re-sends a delivered message whose bookkeeping write failed", async () => {
    await queueMessages(1);
    const transport = new FakeTransport();
    const DB = refusing(() => false, true);

    await expect(drainOutbox({ ...env, DB }, { transport, openAppender: noAppender })).rejects.toThrow(/write limit/);
    expect(transport.sent).toHaveLength(1);

    for (let tick = 0; tick < 3; tick++) {
      const again = await drainOutbox(env, { transport, openAppender: noAppender });
      expect(again.scanned).toBe(0);
    }
    expect(transport.sent).toHaveLength(1);
    const [row] = await outbox();
    expect(row!.status).toBe("pending");
  });

  it("does not let two overlapping drains send one row twice", async () => {
    await queueMessages(1);
    const transport = new FakeTransport();
    const [a, b] = await Promise.all([
      drainOutbox(env, { transport, openAppender: noAppender }),
      drainOutbox(env, { transport, openAppender: noAppender }),
    ]);
    expect(a.sent + b.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });
});
