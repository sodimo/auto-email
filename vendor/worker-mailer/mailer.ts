// From worker-mailer v1.2.1 (MIT, © zou-yu), patched. See README.md.
//
// PATCH 1: the EHLO/HELO hostname is configurable. Upstream announced
// `127.0.0.1`, which Strato accepts with `250 queued` and then silently drops
// for same-provider recipients.
//
// PATCH 3: sending is direct and sequential (upstream queued into a detached
// background loop) and failures throw SmtpError carrying the phase, the server
// response and whether a retry is safe.
import { connect as cfConnect } from "cloudflare:sockets";
import { Email, type EmailOptions } from "./email.js";
import { decode, encode, execTimeout } from "./utils.js";

export type AuthType = "plain" | "login" | "cram-md5";
export type Credentials = { username: string; password: string };

export type SmtpPhase =
  | "connect"
  | "greet"
  | "ehlo"
  | "starttls"
  | "auth"
  | "mail"
  | "rcpt"
  | "data"
  | "body"
  | "quit";

/** The minimum of `cloudflare:sockets`' Socket that this client uses. Declared
 *  structurally so tests can drive the protocol against a mock. */
export interface SocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
  startTls(): SocketLike;
}

export type ConnectFn = (
  address: { hostname: string; port: number },
  options: { secureTransport: "on" | "off" | "starttls"; allowHalfOpen: boolean },
) => SocketLike;

export class SmtpError extends Error {
  readonly phase: SmtpPhase;
  readonly response: string | undefined;
  /**
   * True when the message certainly did not reach the server's queue and the
   * failure looks transient. A failure in the `body` phase with NO response at
   * all is the one case that is never retryable: the bytes were flushed and we
   * cannot know whether they were accepted. Re-sending those risks a duplicate,
   * which auto-email's first hard rule forbids.
   */
  readonly retryable: boolean;

  constructor(phase: SmtpPhase, message: string, response?: string) {
    super(message);
    this.name = "SmtpError";
    this.phase = phase;
    this.response = response;
    this.retryable =
      phase === "body" && response === undefined
        ? false
        : response === undefined || response.startsWith("4");
  }
}

export interface WorkerMailerOptions {
  host: string;
  port: number;
  /** true for implicit TLS (465). */
  secure?: boolean;
  /** true to upgrade with STARTTLS when offered (587). */
  startTls?: boolean;
  credentials?: Credentials;
  /**
   * No default on purpose: upstream's empty default makes auth() throw "No
   * supported auth method found" against every real server. Pass what you mean.
   */
  authType: AuthType | AuthType[];
  /** Announced in EHLO/HELO. Must be a real domain the server will accept. */
  ehloHostname: string;
  socketTimeoutMs?: number;
  responseTimeoutMs?: number;
  connectFn?: ConnectFn;
  onDebug?: (line: string) => void;
}

export interface Envelope {
  /** SMTP MAIL FROM — the bounce address, not necessarily the From: header. */
  from: string;
  to: string[];
}

export class WorkerMailer {
  private socket: SocketLike;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;

  private readonly host: string;
  private readonly port: number;
  private readonly secure: boolean;
  private readonly startTls: boolean;
  private readonly authType: AuthType[];
  private readonly credentials?: Credentials;
  private readonly ehloHostname: string;
  private readonly socketTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly onDebug?: (line: string) => void;

  private allowAuth = false;
  private authTypeSupported: AuthType[] = [];
  private supportsStartTls = false;

  private constructor(options: WorkerMailerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.secure = !!options.secure;
    this.startTls = options.startTls ?? true;
    this.authType = Array.isArray(options.authType) ? options.authType : [options.authType];
    this.credentials = options.credentials;
    this.ehloHostname = options.ehloHostname;
    this.socketTimeoutMs = options.socketTimeoutMs ?? 30_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 30_000;
    this.onDebug = options.onDebug;

    const connectFn = options.connectFn ?? defaultConnect();
    this.socket = connectFn(
      { hostname: this.host, port: this.port },
      {
        secureTransport: this.secure ? "on" : this.startTls ? "starttls" : "off",
        allowHalfOpen: false,
      },
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }

  static async connect(options: WorkerMailerOptions): Promise<WorkerMailer> {
    const mailer = new WorkerMailer(options);
    await mailer.openSession();
    return mailer;
  }

  private debug(line: string): void {
    this.onDebug?.(line);
  }

  private async read(phase: SmtpPhase): Promise<string> {
    const readAll = async (): Promise<string> => {
      let response = "";
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) return response;
        if (!value) continue;
        response += decode(value);
        if (!response.endsWith("\n")) continue;
        const lines = response.split(/\r?\n/);
        // Multi-line replies repeat the code with '-' until the last one.
        if (/^\d+-/.test(lines[lines.length - 2] ?? "")) continue;
        return response;
      }
    };
    const response = await execTimeout(
      readAll(),
      this.responseTimeoutMs,
      new SmtpError(phase, `timed out waiting for the ${this.host} response`),
    );
    this.debug(`S: ${response.trimEnd()}`);
    return response;
  }

  private async writeLine(line: string): Promise<void> {
    this.debug(`C: ${line}`);
    await this.writer.write(encode(`${line}\r\n`));
  }

  private async expect(phase: SmtpPhase, prefix: string, context: string): Promise<string> {
    const response = await this.read(phase);
    if (!response.startsWith(prefix)) {
      throw new SmtpError(phase, `${context}: ${response.trimEnd()}`, response);
    }
    return response;
  }

  private async openSession(): Promise<void> {
    await execTimeout(
      this.socket.opened,
      this.socketTimeoutMs,
      new SmtpError("connect", `could not connect to ${this.host}:${this.port}`),
    );
    await this.expect("greet", "220", "SMTP server did not greet");
    await this.ehlo();

    if (this.startTls && !this.secure && this.supportsStartTls) {
      await this.writeLine("STARTTLS");
      await this.expect("starttls", "220", "STARTTLS refused");
      this.reader.releaseLock();
      this.writer.releaseLock();
      this.socket = this.socket.startTls();
      this.reader = this.socket.readable.getReader();
      this.writer = this.socket.writable.getWriter();
      // RFC 3207: the session resets, so EHLO again.
      await this.ehlo();
    }

    await this.auth();
  }

  private async ehlo(): Promise<void> {
    await this.writeLine(`EHLO ${this.ehloHostname}`);
    const response = await this.read("ehlo");
    if (response.startsWith("421")) {
      throw new SmtpError("ehlo", `EHLO refused: ${response.trimEnd()}`, response);
    }
    if (!response.startsWith("2")) {
      await this.writeLine(`HELO ${this.ehloHostname}`);
      await this.expect("ehlo", "2", "HELO refused");
      return;
    }
    this.parseCapabilities(response);
  }

  private parseCapabilities(response: string): void {
    if (/[ -]AUTH\b/i.test(response)) this.allowAuth = true;
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(response)) this.authTypeSupported.push("plain");
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(response)) this.authTypeSupported.push("login");
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(response)) this.authTypeSupported.push("cram-md5");
    if (/[ -]STARTTLS\b/i.test(response)) this.supportsStartTls = true;
  }

  private async auth(): Promise<void> {
    if (!this.allowAuth) return;
    if (!this.credentials) {
      throw new SmtpError("auth", "the SMTP server requires authentication but no credentials were given");
    }
    const chosen = this.authType.find((type) => this.authTypeSupported.includes(type));
    if (!chosen) {
      throw new SmtpError(
        "auth",
        `no shared auth method: asked for [${this.authType.join(", ")}], server offers [${this.authTypeSupported.join(", ")}]`,
      );
    }
    if (chosen === "plain") await this.authWithPlain();
    else if (chosen === "login") await this.authWithLogin();
    else await this.authWithCramMD5();
  }

  private async authWithPlain(): Promise<void> {
    const { username, password } = this.credentials!;
    await this.writeLine(`AUTH PLAIN ${btoa(`\u0000${username}\u0000${password}`)}`);
    await this.expect("auth", "2", "AUTH PLAIN rejected");
  }

  private async authWithLogin(): Promise<void> {
    const { username, password } = this.credentials!;
    await this.writeLine("AUTH LOGIN");
    await this.expect("auth", "3", "AUTH LOGIN refused");
    await this.writeLine(btoa(username));
    await this.expect("auth", "3", "AUTH LOGIN username rejected");
    await this.writeLine(btoa(password));
    await this.expect("auth", "2", "AUTH LOGIN password rejected");
  }

  private async authWithCramMD5(): Promise<void> {
    const { username, password } = this.credentials!;
    await this.writeLine("AUTH CRAM-MD5");
    const challengeResponse = await this.read("auth");
    const challengeBase64 = challengeResponse.match(/^334\s+(.+)$/m)?.pop();
    if (!challengeBase64) {
      throw new SmtpError("auth", `invalid CRAM-MD5 challenge: ${challengeResponse.trimEnd()}`, challengeResponse);
    }
    const key = await crypto.subtle.importKey("raw", encode(password), { name: "HMAC", hash: "MD5" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encode(atob(challengeBase64)));
    const solved = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await this.writeLine(btoa(`${username} ${solved}`));
    await this.expect("auth", "2", "AUTH CRAM-MD5 rejected");
  }

  /** Convenience wrapper: build the message and send it in one call. */
  async send(options: EmailOptions): Promise<string> {
    const email = new Email(options);
    return await this.sendRaw({ from: email.from.email, to: email.to.map((u) => u.email) }, email.buildMessage());
  }

  /**
   * Sends already-built RFC 5322 bytes. Returns the server's final response.
   * The same bytes can then be handed to IMAP APPEND — dot-stuffing and the
   * terminator are applied here, to the wire copy only.
   */
  async sendRaw(envelope: Envelope, message: Uint8Array): Promise<string> {
    await this.writeLine(`MAIL FROM:<${envelope.from}>`);
    await this.expect("mail", "2", `MAIL FROM <${envelope.from}> rejected`);

    for (const recipient of envelope.to) {
      await this.writeLine(`RCPT TO:<${recipient}>`);
      await this.expect("rcpt", "2", `RCPT TO <${recipient}> rejected`);
    }

    await this.writeLine("DATA");
    await this.expect("data", "354", "DATA refused");

    this.debug(`C: <${message.byteLength} bytes> .`);
    await this.writer.write(dotStuff(message));
    await this.writer.write(encode(endsWithCrLf(message) ? ".\r\n" : "\r\n.\r\n"));
    return await this.expect("body", "2", "message body rejected");
  }

  /** Best effort: a failure to QUIT cleanly never invalidates a delivery. */
  async close(): Promise<void> {
    try {
      await this.writeLine("QUIT");
      await this.read("quit");
    } catch {
      // The server may already have closed the connection.
    }
    try {
      await this.socket.close();
    } catch {
      // Fire and forget: if the peer closed first this never settles.
    }
  }
}

function defaultConnect(): ConnectFn {
  return (address, options) => cfConnect(address, options) as unknown as SocketLike;
}

function endsWithCrLf(message: Uint8Array): boolean {
  const n = message.length;
  return n >= 2 && message[n - 2] === 0x0d && message[n - 1] === 0x0a;
}

/** RFC 5321 §4.5.2: a leading '.' on any line is doubled on the wire. */
export function dotStuff(message: Uint8Array): Uint8Array {
  let extra = 0;
  for (let i = 0; i < message.length; i++) {
    if (message[i] === 0x2e && (i === 0 || (i >= 2 && message[i - 2] === 0x0d && message[i - 1] === 0x0a))) {
      extra++;
    }
  }
  if (extra === 0) return message;

  const out = new Uint8Array(message.length + extra);
  let j = 0;
  for (let i = 0; i < message.length; i++) {
    const byte = message[i]!;
    if (byte === 0x2e && (i === 0 || (i >= 2 && message[i - 2] === 0x0d && message[i - 1] === 0x0a))) {
      out[j++] = 0x2e;
    }
    out[j++] = byte;
  }
  return out;
}
