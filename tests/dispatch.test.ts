import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../src/lib/dispatch.js";
import type { Job, Recipient, Settings } from "../src/types.js";
import { FakeMailer, insertJob, sendLog } from "./helpers.js";

const pinned: Recipient = { email: "thomas@leger.run", display_name: "Thomas" };
const live: Settings = {
  kill_switch: "off",
  test_mode: "on",
  from_address: "rapports@sodimo.eu",
  from_name: "Rapports Sodimo",
};

let job: Job;
beforeEach(async () => {
  job = await insertJob({ name: "dispatch-test" });
});

const send = (mailer: FakeMailer, overrides: Partial<Parameters<typeof dispatch>[0]> = {}) =>
  dispatch({
    db: env.DB,
    settings: live,
    mailer,
    job,
    recipient: pinned,
    dedupeKey: "run:2026-07-29T06:00Z",
    subject: "Rapport",
    html: "<p>Rapport</p>",
    text: "Rapport",
    ...overrides,
  });

describe("the happy path", () => {
  it("sends once and records it", async () => {
    const mailer = new FakeMailer();
    const outcome = await send(mailer);

    expect(outcome.result).toBe("sent");
    expect(mailer.recipients).toEqual(["thomas@leger.run"]);
    expect(mailer.sent[0]!.from).toEqual({ email: "rapports@sodimo.eu", name: "Rapports Sodimo" });

    const log = await sendLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "sent", recipient: "thomas@leger.run" });
  });

  it("logs the Message-ID it actually put on the wire", async () => {
    const mailer = new FakeMailer();
    const outcome = await send(mailer);
    const row = await env.DB.prepare("SELECT message_id FROM send_log").first<{ message_id: string }>();
    expect(outcome.result === "sent" && outcome.messageId).toBe(row!.message_id);
    expect(row!.message_id).toMatch(/^<[0-9a-f-]{36}@sodimo\.eu>$/);
  });
});

describe("idempotency", () => {
  it("never sends the same (job, recipient, dedupe_key) twice", async () => {
    const mailer = new FakeMailer();
    expect((await send(mailer)).result).toBe("sent");
    expect((await send(mailer)).result).toBe("duplicate");
    expect((await send(mailer)).result).toBe("duplicate");

    expect(mailer.sent).toHaveLength(1);
    expect(await sendLog()).toHaveLength(1);
  });

  it("treats concurrent attempts on one key as a single send", async () => {
    const mailer = new FakeMailer();
    const outcomes = await Promise.all([send(mailer), send(mailer), send(mailer)]);
    expect(outcomes.filter((o) => o.result === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o.result === "duplicate")).toHaveLength(2);
    expect(mailer.sent).toHaveLength(1);
  });

  it("still sends under a different key, recipient or job", async () => {
    const mailer = new FakeMailer();
    await send(mailer);
    expect((await send(mailer, { dedupeKey: "run:2026-07-30T06:00Z" })).result).toBe("sent");
    expect((await send(mailer, { recipient: { email: "tombionic@gmail.com", display_name: null } })).result).toBe(
      "sent",
    );
    const other = await insertJob({ name: "dispatch-test-2" });
    expect((await send(mailer, { job: other })).result).toBe("sent");
    expect(mailer.sent).toHaveLength(4);
  });

  it("does not re-send after a failure — the claim stands", async () => {
    const failing = new FakeMailer(() => new Error("550 mailbox unavailable"));
    expect(await send(failing)).toEqual({ result: "failed", error: "550 mailbox unavailable" });
    expect((await sendLog())[0]).toMatchObject({ status: "failed", smtp_response: "550 mailbox unavailable" });

    // A later run of the same slot must not try again behind the operator's back.
    const retry = new FakeMailer();
    expect((await send(retry)).result).toBe("duplicate");
    expect(retry.sent).toHaveLength(0);
  });
});

describe("the guard is inside the choke point", () => {
  it("suppresses everything when the kill switch is engaged", async () => {
    const mailer = new FakeMailer();
    const outcome = await send(mailer, { settings: { ...live, kill_switch: "on" } });

    expect(outcome).toMatchObject({ result: "blocked", status: "suppressed" });
    expect(mailer.sent).toHaveLength(0);
    expect((await sendLog())[0]).toMatchObject({ status: "suppressed" });
  });

  it("records an unpinned recipient as skipped_test_mode without contacting SMTP", async () => {
    const mailer = new FakeMailer();
    const outcome = await send(mailer, { recipient: { email: "rani@sodimo.eu", display_name: "Rani" } });

    expect(outcome).toMatchObject({ result: "blocked", status: "skipped_test_mode" });
    expect(mailer.sent).toHaveLength(0);
    expect((await sendLog())[0]).toMatchObject({ status: "skipped_test_mode", recipient: "rani@sodimo.eu" });
  });

  it("refuses to send when the From identity is unconfigured", async () => {
    const mailer = new FakeMailer();
    const outcome = await send(mailer, { settings: { kill_switch: "off", test_mode: "on" } });
    expect(outcome.result).toBe("failed");
    expect(mailer.sent).toHaveLength(0);
  });
});
