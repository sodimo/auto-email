/**
 * SMTP seam. `MailTransport` / `MailSession` is the ONLY interface the drain
 * knows about, which is what lets the tests exercise the whole send path
 * without opening a socket.
 *
 * A session is opened ONCE per drain run and reused for the batch (Strato
 * allows 1000 messages per connection); reconnecting per message would spend
 * the invocation's CPU budget on TLS handshakes.
 *
 * Transport is the vendored, patched worker-mailer (see vendor/worker-mailer).
 * Port 25 is blocked on Workers and is refused below.
 */
import { Email, SmtpError, WorkerMailer } from "../../vendor/worker-mailer/index.js";
import { SMTP_AUTH_TYPES } from "../config.js";
import type { Env, Settings } from "../types.js";

export interface OutboundMessage {
  to: { email: string; name?: string | null };
  from: { email: string; name: string };
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
  /** RFC 5322 Message-ID, generated at enqueue so it is logged before sending. */
  messageId: string;
}

export interface MailSession {
  /** Returns the server's final response to the message body. */
  sendRaw(to: string, raw: Uint8Array): Promise<string>;
  close(): Promise<void>;
}

export interface MailTransport {
  open(): Promise<MailSession>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** The AUTH identity, and the SMTP envelope sender. Not necessarily the
   *  `From:` header — see settings.smtp_username. */
  username: string;
  password: string;
  ehloHostname: string;
}

/** `<uuid@sodimo.eu>`, derived from the From address so it stays DMARC-aligned. */
export function newMessageId(fromAddress: string): string {
  const domain = fromAddress.split("@").pop() || "sodimo.eu";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/**
 * The message as RFC 5322 bytes — built ONCE and handed to both SMTP (which
 * dot-stuffs and terminates its own copy on the way out) and IMAP APPEND
 * (which stores these bytes verbatim). Building twice would archive a copy
 * that differs from the one delivered, down to the MIME boundary and Date.
 */
export function buildMessage(message: OutboundMessage): Uint8Array {
  return new Email({
    from: { name: message.from.name, email: message.from.email },
    to: message.to.name ? { name: message.to.name, email: message.to.email } : message.to.email,
    ...(message.replyTo ? { reply: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: {
      "Message-ID": message.messageId,
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
    },
  }).buildMessage();
}

export function smtpConfigFromSettings(settings: Settings, env: Env): SmtpConfig {
  const host = settings.smtp_host;
  const fromAddress = settings.from_address;
  const ehloHostname = settings.ehlo_hostname;
  if (!host) throw new Error("settings.smtp_host is not configured");
  if (!fromAddress) throw new Error("settings.from_address is not configured");
  if (!ehloHostname) {
    // Refusing beats defaulting: announcing 127.0.0.1 makes Strato accept the
    // message and then silently drop it for same-provider recipients.
    throw new Error("settings.ehlo_hostname is not configured");
  }

  const port = Number(settings.smtp_port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`settings.smtp_port is not a port number: ${settings.smtp_port}`);
  }
  if (port === 25) {
    throw new Error("port 25 is unavailable on Cloudflare Workers — use 465 (SSL) or 587 (STARTTLS)");
  }
  if (!env.STRATO_SMTP_PASSWORD) {
    throw new Error("STRATO_SMTP_PASSWORD secret is not set on this Worker");
  }

  // The envelope sender and AUTH identity default to the From address, but can
  // be split so the mailbox that authenticates differs from the one shown to
  // the reader. Whether Strato allows that is the first thing to test live.
  const username = settings.smtp_username?.trim() || fromAddress;

  return { host, port, username, password: env.STRATO_SMTP_PASSWORD, ehloHostname };
}

export class StratoTransport implements MailTransport {
  constructor(private readonly config: SmtpConfig) {}

  async open(): Promise<MailSession> {
    // 465 is implicit TLS from the first byte; 587 starts plaintext and is
    // upgraded with STARTTLS. Moving between them is a settings.smtp_port
    // change — there is deliberately no automatic fallback.
    const implicitTls = this.config.port === 465;
    const connection = await WorkerMailer.connect({
      host: this.config.host,
      port: this.config.port,
      secure: implicitTls,
      startTls: !implicitTls,
      credentials: { username: this.config.username, password: this.config.password },
      authType: SMTP_AUTH_TYPES,
      ehloHostname: this.config.ehloHostname,
      socketTimeoutMs: 20_000,
      responseTimeoutMs: 20_000,
    });

    const from = this.config.username;
    return {
      async sendRaw(to: string, raw: Uint8Array): Promise<string> {
        return (await connection.sendRaw({ from, to: [to] }, raw)).trimEnd();
      },
      close: () => connection.close(),
    };
  }
}

export function createTransport(settings: Settings, env: Env): MailTransport {
  return new StratoTransport(smtpConfigFromSettings(settings, env));
}

/** True only when the client can prove the message did not reach the server's
 *  queue and the failure looks transient. Anything else must not be retried. */
export function isRetryable(cause: unknown): boolean {
  return cause instanceof SmtpError && cause.retryable;
}
