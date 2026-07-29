/**
 * Minimal IMAP client with exactly one job: APPEND a copy of each sent message
 * to the mailbox's Sent folder, so the team sees automated sendings in Strato
 * webmail alongside their own.
 *
 * Hand-rolled because nothing usable exists — cf-imap and friends are read-only
 * clients. This is deliberately not a general IMAP library: greeting, LOGIN,
 * LIST, APPEND, LOGOUT.
 *
 * Two details are load-bearing:
 *
 *  - **The Sent folder is discovered, never assumed.** `LIST (SPECIAL-USE) "" "*"`
 *    and the `\Sent` attribute; the localised display name varies.
 *  - **APPEND uses a SYNCHRONIZING literal.** The server advertises no LITERAL+,
 *    so the byte count is sent, the `+` continuation is awaited, and only then
 *    are the bytes written. Code that writes early hangs until the timeout.
 *
 * A failure here must NEVER fail the send: the email already went out. Callers
 * record the outcome separately (`send_log.append_status`).
 */
import type { ConnectFn, SocketLike } from "../../vendor/worker-mailer/index.js";

export class ImapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapError";
  }
}

export interface ImapConfig {
  host: string;
  /** 993, implicit TLS. */
  port: number;
  username: string;
  password: string;
  /** Skips discovery when set — for a server that hides the \Sent attribute. */
  folderOverride?: string | undefined;
  timeoutMs?: number;
  connectFn?: ConnectFn;
  onDebug?: (line: string) => void;
}

export type AppendStatus = "appended" | "failed";

export interface AppendResult {
  status: AppendStatus;
  /** The tagged OK line, which carries `[APPENDUID <uidvalidity> <uid>]`. */
  response: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** `* LIST (\HasNoChildren \Sent) "/" "Sent"` → `Sent` */
export function parseListedMailbox(line: string): string {
  const match = /^\*\s+LIST\s+\([^)]*\)\s+(?:"(?:\\.|[^"\\])*"|NIL)\s+(.+)$/.exec(line.trim());
  if (!match?.[1]) throw new ImapError(`could not parse a LIST response: ${line}`);
  return unquote(match[1]);
}

export function hasSentAttribute(line: string): boolean {
  const attributes = /^\*\s+LIST\s+\(([^)]*)\)/.exec(line.trim())?.[1] ?? "";
  return /\\Sent\b/i.test(attributes);
}

class ImapConnection {
  private buffer = "";
  private tagCounter = 0;

  private constructor(
    private readonly socket: SocketLike,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly timeoutMs: number,
    private readonly onDebug?: (line: string) => void,
  ) {}

  static async open(config: ImapConfig): Promise<ImapConnection> {
    const connectFn = config.connectFn ?? (await defaultConnect());
    const socket = connectFn(
      { hostname: config.host, port: config.port },
      { secureTransport: "on", allowHalfOpen: false },
    );
    const connection = new ImapConnection(
      socket,
      socket.readable.getReader(),
      socket.writable.getWriter(),
      config.timeoutMs ?? 20_000,
      config.onDebug,
    );
    await connection.withTimeout(socket.opened, `could not connect to ${config.host}:${config.port}`);

    const greeting = await connection.readLine();
    if (!greeting.startsWith("* OK")) {
      throw new ImapError(`IMAP server did not greet: ${greeting}`);
    }
    await connection.command(`LOGIN ${quote(config.username)} ${quote(config.password)}`, "LOGIN <redacted>");
    return connection;
  }

  private async withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    return await Promise.race<T>([
      promise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new ImapError(message)), this.timeoutMs)),
    ]);
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf("\r\n");
      if (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.onDebug?.(`S: ${line}`);
        return line;
      }
      const { value, done } = await this.withTimeout(this.reader.read(), "timed out reading from the IMAP server");
      if (done) throw new ImapError("IMAP connection closed mid-response");
      if (value) this.buffer += decoder.decode(value, { stream: true });
    }
  }

  private async write(text: string, debugAs?: string): Promise<void> {
    this.onDebug?.(`C: ${debugAs ?? text.trimEnd()}`);
    await this.writer.write(encoder.encode(text));
  }

  private nextTag(): string {
    return `a${++this.tagCounter}`;
  }

  /** Runs a tagged command and returns the untagged lines plus the tagged one. */
  private async command(
    command: string,
    debugAs?: string,
  ): Promise<{ lines: string[]; tagged: string }> {
    const tag = this.nextTag();
    await this.write(`${tag} ${command}\r\n`, debugAs ? `${tag} ${debugAs}` : undefined);
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) {
          throw new ImapError(`${debugAs ?? command.split(" ")[0]} failed: ${line}`);
        }
        return { lines, tagged: line };
      }
      lines.push(line);
    }
  }

  async findSentFolder(): Promise<string> {
    const { lines } = await this.command('LIST (SPECIAL-USE) "" "*"');
    for (const line of lines) {
      if (line.startsWith("* LIST") && hasSentAttribute(line)) return parseListedMailbox(line);
    }
    throw new ImapError(
      "no mailbox advertises the \\Sent special-use attribute — set settings.sent_folder_override",
    );
  }

  async append(folder: string, message: Uint8Array): Promise<string> {
    const tag = this.nextTag();
    // TextEncoder byte length, not String.length: the count is in octets and
    // French accented characters are multi-byte.
    await this.write(`${tag} APPEND ${quote(folder)} (\\Seen) {${message.byteLength}}\r\n`);

    // SYNCHRONIZING literal: the server must say "+" before the bytes go.
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith("+")) break;
      if (line.startsWith(`${tag} `)) throw new ImapError(`APPEND refused: ${line}`);
    }

    await this.writer.write(message);
    await this.write("\r\n", "<message bytes>");

    for (;;) {
      const line = await this.readLine();
      if (!line.startsWith(`${tag} `)) continue;
      if (!line.startsWith(`${tag} OK`)) throw new ImapError(`APPEND failed: ${line}`);
      return line;
    }
  }

  async close(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // Already gone; nothing to salvage.
    }
    try {
      await this.socket.close();
    } catch {
      // Fire and forget.
    }
  }
}

/**
 * One IMAP session for a whole drain run: connect, resolve the Sent folder
 * once, then append each message as it is sent.
 */
export interface SentAppender {
  readonly folder: string;
  append(message: Uint8Array): Promise<AppendResult>;
  close(): Promise<void>;
}

export async function openSentAppender(config: ImapConfig): Promise<SentAppender> {
  const connection = await ImapConnection.open(config);
  let folder: string;
  try {
    folder = config.folderOverride?.trim() ? config.folderOverride.trim() : await connection.findSentFolder();
  } catch (cause) {
    await connection.close();
    throw cause;
  }

  return {
    folder,
    async append(message: Uint8Array): Promise<AppendResult> {
      try {
        return { status: "appended", response: await connection.append(folder, message) };
      } catch (cause) {
        // Never rethrow: the email is already delivered.
        return { status: "failed", response: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    close: () => connection.close(),
  };
}

async function defaultConnect(): Promise<ConnectFn> {
  const { connect } = await import("cloudflare:sockets");
  return (address, options) => connect(address, options) as unknown as SocketLike;
}
