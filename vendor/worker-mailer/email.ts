// From worker-mailer v1.2.1 (MIT, © zou-yu), patched. See README.md.
//
// PATCH 2: getEmailData() (wire format: dot-stuffed, `\r\n.\r\n`-terminated
// string) is replaced by buildMessage(), which returns clean RFC 5322 bytes.
// Dot-stuffing and termination belong to the SMTP transport and now live in
// mailer.ts; IMAP APPEND needs these bytes unmodified.
//
// REMOVED: bcc (upstream emitted a literal BCC: header, exposing every
// recipient to all of them), cc, attachments, DSN.
import { encode, encodeQuotedPrintable } from "./utils.js";

export type User = { name?: string; email: string };

export type EmailOptions = {
  from: string | User;
  to: string | string[] | User | User[];
  reply?: string | User;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
};

/** RFC 2047 encoded-word for header values containing non-ASCII. */
export function encodeHeader(text: string): string {
  if (!/[^\x00-\x7F]/.test(text)) return text;

  let encoded = "";
  for (const byte of encode(text)) {
    // Printable ASCII except '?', '=', '_'; space becomes '_'.
    if (byte >= 33 && byte <= 126 && byte !== 63 && byte !== 61 && byte !== 95) {
      encoded += String.fromCharCode(byte);
    } else if (byte === 32) {
      encoded += "_";
    } else {
      encoded += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return `=?UTF-8?Q?${encoded}?=`;
}

function toUsers(value: string | string[] | User | User[] | undefined): User[] | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return [{ email: value }];
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? { email: v } : v));
  return [value];
}

function formatAddress(user: User): string {
  return user.name ? `"${encodeHeader(user.name)}" <${user.email}>` : user.email;
}

export class Email {
  readonly from: User;
  readonly to: User[];
  readonly reply?: User;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers: Record<string, string>;

  constructor(options: EmailOptions) {
    if (!options.text && !options.html) {
      throw new Error("At least one of text or html must be provided");
    }
    this.from = typeof options.from === "string" ? { email: options.from } : options.from;
    this.reply = typeof options.reply === "string" ? { email: options.reply } : options.reply;
    this.to = toUsers(options.to)!;
    this.subject = options.subject;
    this.text = options.text;
    this.html = options.html;
    this.headers = { ...options.headers };
  }

  private generateSafeBoundary(prefix: string): string {
    const bytes = new Uint8Array(28);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return (prefix + hex).replace(/[<>@,;:\\/[\]?=" ]/g, "_");
  }

  private resolveHeaders(): void {
    this.headers["From"] ??= formatAddress(this.from);
    this.headers["To"] ??= this.to.map(formatAddress).join(", ");
    if (this.reply) this.headers["Reply-To"] ??= formatAddress(this.reply);
    if (this.subject) this.headers["Subject"] ??= encodeHeader(this.subject);
    this.headers["Date"] ??= new Date().toUTCString();
    this.headers["Message-ID"] ??= `<${crypto.randomUUID()}@${this.from.email.split("@").pop()}>`;
  }

  /**
   * The message as RFC 5322 bytes: CRLF line endings, no dot-stuffing, no
   * trailing `.` line. Safe to hand to both SMTP (which stuffs and terminates
   * on the way out) and IMAP APPEND (which must store it verbatim).
   */
  buildMessage(): Uint8Array {
    this.resolveHeaders();

    const boundary = this.generateSafeBoundary("alt_");
    const lines: string[] = ["MIME-Version: 1.0"];
    for (const [key, value] of Object.entries(this.headers)) lines.push(`${key}: ${value}`);
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    let message = `${lines.join("\r\n")}\r\n\r\n`;

    if (this.text) {
      message += `--${boundary}\r\n`;
      message += `Content-Type: text/plain; charset="UTF-8"\r\n`;
      message += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`;
      message += `${encodeQuotedPrintable(this.text)}\r\n\r\n`;
    }
    if (this.html) {
      message += `--${boundary}\r\n`;
      message += `Content-Type: text/html; charset="UTF-8"\r\n`;
      message += `Content-Transfer-Encoding: quoted-printable\r\n\r\n`;
      message += `${encodeQuotedPrintable(this.html)}\r\n\r\n`;
    }
    message += `--${boundary}--\r\n`;

    return encode(message);
  }
}
