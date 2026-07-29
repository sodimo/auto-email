import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueue } from "../src/lib/enqueue.js";
import type { Job, Recipient, Settings } from "../src/types.js";
import { insertJob, outbox, sendLog } from "./helpers.js";

const pinned: Recipient = { email: "thomas@leger.run", display_name: "Thomas" };
const live: Settings = {
  kill_switch: "off",
  test_mode: "on",
  from_address: "rapports@sodimo.eu",
  from_name: "Rapports Sodimo",
};

let job: Job;
beforeEach(async () => {
  job = await insertJob({ name: "enqueue-test" });
});

const queue = (overrides: Partial<Parameters<typeof enqueue>[0]> = {}) =>
  enqueue({
    db: env.DB,
    settings: live,
    job,
    recipient: pinned,
    dedupeKey: "run:2026-07-29T06:00Z",
    subject: "Rapport",
    html: "<p>Rapport</p>",
    text: "Rapport",
    ...overrides,
  });

describe("the happy path", () => {
  it("claims the ledger row and queues the rendered message", async () => {
    const outcome = await queue();
    expect(outcome.result).toBe("queued");

    const log = await sendLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "pending", recipient: "thomas@leger.run" });

    const queued = await outbox();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "pending", attempts: 0, subject: "Rapport" });
  });

  it("records the Message-ID before anything is sent", async () => {
    const outcome = await queue();
    const row = await env.DB.prepare(
      "SELECT s.message_id, o.rfc_message_id FROM send_log s JOIN outbox o ON o.send_log_id = s.id",
    ).first<{ message_id: string; rfc_message_id: string }>();

    expect(outcome.result === "queued" && outcome.messageId).toBe(row!.message_id);
    expect(row!.rfc_message_id).toBe(row!.message_id);
    expect(row!.message_id).toMatch(/^<[0-9a-f-]{36}@sodimo\.eu>$/);
  });
});

describe("idempotency", () => {
  it("never queues the same (job, recipient, dedupe_key) twice", async () => {
    expect((await queue()).result).toBe("queued");
    expect((await queue()).result).toBe("duplicate");
    expect((await queue()).result).toBe("duplicate");

    expect(await outbox()).toHaveLength(1);
    expect(await sendLog()).toHaveLength(1);
  });

  it("treats concurrent attempts on one key as a single claim", async () => {
    const outcomes = await Promise.all([queue(), queue(), queue()]);
    expect(outcomes.filter((o) => o.result === "queued")).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === "duplicate")).toHaveLength(2);
    expect(await outbox()).toHaveLength(1);
  });

  it("still queues under a different key, recipient or job", async () => {
    await queue();
    expect((await queue({ dedupeKey: "run:2026-07-30T06:00Z" })).result).toBe("queued");
    expect((await queue({ recipient: { email: "tombionic@gmail.com", display_name: null } })).result).toBe("queued");
    expect((await queue({ job: await insertJob({ name: "enqueue-test-2" }) })).result).toBe("queued");
    expect(await outbox()).toHaveLength(4);
  });
});

describe("the guard sits in front of the queue", () => {
  it("suppresses everything when the kill switch is engaged", async () => {
    const outcome = await queue({ settings: { ...live, kill_switch: "on" } });

    expect(outcome).toMatchObject({ result: "blocked", status: "suppressed" });
    expect(await outbox()).toEqual([]);
    expect((await sendLog())[0]).toMatchObject({ status: "suppressed" });
  });

  it("records an unpinned recipient as skipped_test_mode and queues nothing", async () => {
    const outcome = await queue({ recipient: { email: "rani@sodimo.eu", display_name: "Rani" } });

    expect(outcome).toMatchObject({ result: "blocked", status: "skipped_test_mode" });
    expect(await outbox()).toEqual([]);
    expect((await sendLog())[0]).toMatchObject({ status: "skipped_test_mode", recipient: "rani@sodimo.eu" });
  });

  it("refuses to queue when the From identity is unconfigured", async () => {
    const outcome = await queue({ settings: { kill_switch: "off", test_mode: "on" } });
    expect(outcome.result).toBe("failed");
    expect(await outbox()).toEqual([]);
  });
});
