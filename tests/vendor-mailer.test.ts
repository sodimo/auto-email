/**
 * Pins the three patches in vendor/worker-mailer. If any of these fail after a
 * vendor update, the patch was lost — re-read vendor/worker-mailer/README.md
 * before "fixing" the test.
 */
import { describe, expect, it } from "vitest";
import { dotStuff, Email, SmtpError, WorkerMailer } from "../vendor/worker-mailer/index.js";
import { SMTP_AUTH_TYPES } from "../src/config.js";
import { connectTo, smtpServer } from "./mock-socket.js";

const decoder = new TextDecoder();

function message(overrides: Partial<ConstructorParameters<typeof Email>[0]> = {}): Email {
  return new Email({
    from: { name: "Rapports Sodimo", email: "rapports@sodimo.eu" },
    to: { name: "Thomas Léger", email: "thomas@leger.run" },
    subject: "Rapport quotidien — été",
    text: "Bonjour,\nRapport du jour.\n",
    html: "<p>Bonjour</p>",
    headers: { "Message-ID": "<fixed@sodimo.eu>" },
    ...overrides,
  });
}

describe("PATCH 1 — the EHLO hostname is ours, not 127.0.0.1", () => {
  it("announces the configured hostname on the wire", async () => {
    const { socket } = smtpServer();
    const mailer = await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });
    await mailer.close();

    expect(socket.writes[0]).toBe("EHLO sodimo.eu\r\n");
    expect(socket.writes.join("")).not.toContain("127.0.0.1");
  });

  it("uses the same hostname when falling back to HELO", async () => {
    const { socket } = smtpServer({ capabilities: "500 unrecognised command\r\n" });
    await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });

    expect(socket.writes).toContain("HELO sodimo.eu\r\n");
  });
});

describe("PATCH 2 — buildMessage returns clean RFC 5322 bytes", () => {
  it("has no SMTP terminator and no dot-stuffing", () => {
    const raw = decoder.decode(message().buildMessage());
    expect(raw.endsWith("\r\n.\r\n")).toBe(false);
    expect(raw).toContain("Message-ID: <fixed@sodimo.eu>");
    expect(raw).toContain("From: \"Rapports Sodimo\" <rapports@sodimo.eu>");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain("multipart/alternative");
  });

  it("RFC 2047-encodes non-ASCII headers", () => {
    const raw = decoder.decode(message().buildMessage());
    expect(raw).toMatch(/Subject: =\?UTF-8\?Q\?.*\?=/);
    expect(raw).toContain("=?UTF-8?Q?Thomas_L=C3=A9ger?=");
  });

  it("stuffs leading dots on the WIRE copy only", async () => {
    const withDot = message({ text: "Bonjour,\n.leading dot\n" });
    const raw = withDot.buildMessage();
    expect(decoder.decode(raw)).toContain("\r\n.leading dot");
    expect(decoder.decode(raw)).not.toContain("\r\n..leading dot");

    const { socket, body } = smtpServer();
    const mailer = await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });
    await mailer.sendRaw({ from: "rapports@sodimo.eu", to: ["thomas@leger.run"] }, raw);

    expect(body()).toContain("\r\n..leading dot");
    expect(body().endsWith("\r\n.\r\n")).toBe(true);
  });

  it("dotStuff doubles only line-initial dots, and copies nothing when it need not", () => {
    const encoder = new TextEncoder();
    const untouched = encoder.encode("no dots here\r\nat all\r\n");
    expect(dotStuff(untouched)).toBe(untouched);

    expect(decoder.decode(dotStuff(encoder.encode(".start\r\n")))).toBe("..start\r\n");
    expect(decoder.decode(dotStuff(encoder.encode("a\r\n.b\r\n")))).toBe("a\r\n..b\r\n");
    expect(decoder.decode(dotStuff(encoder.encode("mid.dle\r\n")))).toBe("mid.dle\r\n");
  });
});

describe("REMOVED — bcc cannot leak, because it does not exist", () => {
  it("never emits a BCC header", () => {
    // @ts-expect-error bcc was deliberately deleted from the vendored options.
    const raw = decoder.decode(message({ bcc: "secret@sodimo.eu" }).buildMessage());
    expect(raw).not.toContain("BCC");
    expect(raw).not.toContain("secret@sodimo.eu");
  });
});

describe("visible CC headers", () => {
  it("emits every CC address while keeping BCC unavailable", () => {
    const raw = decoder.decode(message({
      to: ["paul.ghafary@sodimo.eu", "rani@sodimo.eu"],
      cc: ["direction@sodimo.eu", "compta@sodimo.eu"],
    }).buildMessage());

    expect(raw).toContain("To: paul.ghafary@sodimo.eu, rani@sodimo.eu");
    expect(raw).toContain("Cc: direction@sodimo.eu, compta@sodimo.eu");
    expect(raw).not.toContain("Bcc:");
  });
});

describe("PATCH 3 — failures carry a phase and a retry verdict", () => {
  it("retries only what provably did not deliver", () => {
    expect(new SmtpError("mail", "busy", "451 4.3.2 busy\r\n").retryable).toBe(true);
    expect(new SmtpError("connect", "no route").retryable).toBe(true);
    expect(new SmtpError("rcpt", "no such user", "550 5.1.1 no such user\r\n").retryable).toBe(false);
    expect(new SmtpError("auth", "bad password", "535 5.7.8 bad password\r\n").retryable).toBe(false);
    // Rejected after the bytes went out, but explicitly: safe to try again.
    expect(new SmtpError("body", "try later", "451 4.7.1 try later\r\n").retryable).toBe(true);
    // Flushed the bytes and heard nothing back: delivery is UNKNOWN, so no.
    expect(new SmtpError("body", "timed out").retryable).toBe(false);
  });

  it("tags a rejected recipient with the rcpt phase", async () => {
    const { socket } = smtpServer({ replies: { rcpt: "550 5.1.1 unknown recipient\r\n" } });
    const mailer = await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });

    const failure = await mailer
      .sendRaw({ from: "rapports@sodimo.eu", to: ["nobody@sodimo.eu"] }, message().buildMessage())
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(SmtpError);
    expect(failure).toMatchObject({ phase: "rcpt", retryable: false });
  });

  it("returns the server's final response on success", async () => {
    const { socket } = smtpServer({ replies: { body: "250 2.0.0 Ok: queued as 9ABC\r\n" } });
    const mailer = await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });

    const response = await mailer.sendRaw(
      { from: "rapports@sodimo.eu", to: ["thomas@leger.run"] },
      message().buildMessage(),
    );
    expect(response.trimEnd()).toBe("250 2.0.0 Ok: queued as 9ABC");
  });
});

describe("authentication", () => {
  it("uses AUTH PLAIN when the server offers both, per SMTP_AUTH_TYPES", async () => {
    const { socket } = smtpServer();
    await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });

    const authLine = socket.writes.find((w) => w.startsWith("AUTH "));
    expect(authLine).toMatch(/^AUTH PLAIN /);
    expect(atob(authLine!.slice("AUTH PLAIN ".length).trim())).toBe("\u0000rapports@sodimo.eu\u0000secret");
  });

  it("falls back to LOGIN when PLAIN is not offered", async () => {
    const { socket } = smtpServer({ capabilities: "250-smtp.strato.com\r\n250 AUTH LOGIN\r\n" });
    await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "rapports@sodimo.eu", password: "secret" },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    });

    expect(socket.writes).toContain("AUTH LOGIN\r\n");
  });

  it("says so plainly when no auth method is shared", async () => {
    const { socket } = smtpServer({ capabilities: "250-smtp.strato.com\r\n250 AUTH CRAM-MD5\r\n" });
    const failure = await WorkerMailer.connect({
      host: "smtp.strato.com",
      port: 465,
      secure: true,
      credentials: { username: "u", password: "p" },
      authType: ["plain", "login"],
      ehloHostname: "sodimo.eu",
      connectFn: connectTo(socket),
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(SmtpError);
    expect((failure as SmtpError).message).toContain("no shared auth method");
  });
});
