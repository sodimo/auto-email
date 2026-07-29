import { describe, expect, it } from "vitest";
import {
  hasSentAttribute,
  ImapError,
  openSentAppender,
  parseListedMailbox,
} from "../src/lib/imap-append.js";
import { connectTo, createMockSocket, type MockSocket, settle } from "./mock-socket.js";

const encoder = new TextEncoder();

const LIST_RESPONSE =
  '* LIST (\\HasNoChildren \\Drafts) "." "INBOX.Drafts"\r\n' +
  '* LIST (\\HasNoChildren \\Sent) "." "INBOX.Envoy&AOk-s"\r\n' +
  '* LIST (\\HasNoChildren) "." "INBOX"\r\n';

interface ImapScript {
  list?: string;
  /** When true the server withholds the '+' until the test releases it. */
  holdContinuation?: boolean;
  appendReply?: string;
}

function imapServer(script: ImapScript = {}): { socket: MockSocket; release: () => void; literal: () => string } {
  let inLiteral = false;
  let literal = "";
  let expectedBytes = 0;
  let appendTag = "";
  let released: (() => void) | null = null;

  const socket = createMockSocket((chunk, s) => {
    if (inLiteral) {
      literal += chunk;
      // The literal is exactly the announced octet count, then CRLF — the
      // point of a synchronizing literal is that the server knows the length.
      if (encoder.encode(literal).byteLength >= expectedBytes + 2) {
        inLiteral = false;
        s.push(script.appendReply ?? `${appendTag} OK [APPENDUID 1234567890 42] APPEND completed\r\n`);
      }
      return;
    }

    const [tag, verb] = chunk.trimEnd().split(" ");
    if (verb === "LOGIN") {
      s.push(`${tag} OK LOGIN completed\r\n`);
    } else if (verb === "LIST") {
      s.push(`${script.list ?? LIST_RESPONSE}${tag} OK LIST completed\r\n`);
    } else if (verb === "APPEND") {
      appendTag = tag!;
      expectedBytes = Number(/\{(\d+)\}/.exec(chunk)?.[1] ?? 0);
      const emit = (): void => {
        inLiteral = true;
        s.push("+ Ready for literal data\r\n");
      };
      if (script.holdContinuation) released = emit;
      else emit();
    } else if (verb === "LOGOUT") {
      s.push(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
    }
  });

  socket.push("* OK [CAPABILITY IMAP4rev1 SPECIAL-USE] imap.strato.com ready\r\n");
  return { socket, release: () => released?.(), literal: () => literal };
}

const config = (socket: MockSocket, folderOverride?: string) => ({
  host: "imap.strato.com",
  port: 993,
  username: "rapports@sodimo.eu",
  password: "secret",
  folderOverride,
  connectFn: connectTo(socket),
});

describe("LIST parsing", () => {
  it("recognises the \\Sent attribute and only that", () => {
    expect(hasSentAttribute('* LIST (\\HasNoChildren \\Sent) "." "INBOX.Sent"')).toBe(true);
    expect(hasSentAttribute('* LIST (\\HasNoChildren) "." "Sent"')).toBe(false);
    expect(hasSentAttribute('* LIST (\\Drafts) "." "INBOX.Drafts"')).toBe(false);
  });

  it("reads the mailbox name, quoted or not, with any delimiter", () => {
    expect(parseListedMailbox('* LIST (\\Sent) "." "INBOX.Sent"')).toBe("INBOX.Sent");
    expect(parseListedMailbox('* LIST (\\Sent) "/" "Sent Items"')).toBe("Sent Items");
    expect(parseListedMailbox('* LIST (\\Sent) NIL INBOX.Sent')).toBe("INBOX.Sent");
    expect(parseListedMailbox('* LIST (\\Sent) "." "El\\"ements envoy\\\\es"')).toBe('El"ements envoy\\es');
  });
});

describe("folder discovery", () => {
  it("finds the \\Sent mailbox rather than assuming a name", async () => {
    const { socket } = imapServer();
    const appender = await openSentAppender(config(socket));

    // The real mailbox is a localised, modified-UTF-7 name — never "Sent".
    expect(appender.folder).toBe("INBOX.Envoy&AOk-s");
    expect(socket.writes.some((w) => w.includes('LIST (SPECIAL-USE) "" "*"'))).toBe(true);
    await appender.close();
  });

  it("prefers an explicit override and skips discovery", async () => {
    const { socket } = imapServer();
    const appender = await openSentAppender(config(socket, "INBOX.Manuel"));

    expect(appender.folder).toBe("INBOX.Manuel");
    expect(socket.writes.some((w) => w.includes("LIST"))).toBe(false);
    await appender.close();
  });

  it("fails loudly when no mailbox is marked \\Sent", async () => {
    const { socket } = imapServer({ list: '* LIST (\\HasNoChildren) "." "INBOX"\r\n' });
    const failure = await openSentAppender(config(socket)).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ImapError);
    expect((failure as Error).message).toContain("sent_folder_override");
  });

  it("does not leak the password into the debug log", async () => {
    const lines: string[] = [];
    const { socket } = imapServer();
    const appender = await openSentAppender({ ...config(socket), onDebug: (l) => lines.push(l) });

    expect(lines.some((l) => l.includes("LOGIN <redacted>"))).toBe(true);
    expect(lines.join("\n")).not.toContain("secret");
    await appender.close();
  });
});

describe("APPEND", () => {
  it("counts the literal in BYTES, not characters", async () => {
    const { socket } = imapServer();
    const appender = await openSentAppender(config(socket));
    // Accented French: 24 characters, 26 bytes in UTF-8.
    const message = encoder.encode("Subject: été\r\n\r\nRapport à lire\r\n");

    await appender.append(message);

    const command = socket.writes.find((w) => w.includes("APPEND"))!;
    expect(command).toContain(`{${message.byteLength}}`);
    expect(command).not.toContain(`{${"Subject: été\r\n\r\nRapport à lire\r\n".length}}`);
    await appender.close();
  });

  it("uses the discovered folder and marks the copy \\Seen", async () => {
    const { socket } = imapServer();
    const appender = await openSentAppender(config(socket));
    await appender.append(encoder.encode("hello\r\n"));

    const command = socket.writes.find((w) => w.includes("APPEND"))!;
    expect(command).toContain('APPEND "INBOX.Envoy&AOk-s" (\\Seen) {7}');
    await appender.close();
  });

  it("WAITS for the '+' continuation before writing a single byte", async () => {
    const { socket, release, literal } = imapServer({ holdContinuation: true });
    const appender = await openSentAppender(config(socket));
    const before = socket.writes.length;

    const pending = appender.append(encoder.encode("body\r\n"));
    await settle();

    // The command line went out; the message did NOT. Strato has no LITERAL+,
    // so a client that writes early hangs until the timeout.
    expect(socket.writes.length).toBe(before + 1);
    expect(literal()).toBe("");

    release();
    const result = await pending;

    expect(result.status).toBe("appended");
    expect(literal()).toBe("body\r\n\r\n");
    await appender.close();
  });

  it("returns the APPENDUID line for the send log", async () => {
    const { socket } = imapServer();
    const appender = await openSentAppender(config(socket));

    const result = await appender.append(encoder.encode("hello\r\n"));

    expect(result.status).toBe("appended");
    expect(result.response).toContain("[APPENDUID 1234567890 42]");
    await appender.close();
  });

  it("reports a refused APPEND without throwing — the email already went out", async () => {
    const { socket } = imapServer({ appendReply: "a3 NO [OVERQUOTA] mailbox is full\r\n" });
    const appender = await openSentAppender(config(socket));

    const result = await appender.append(encoder.encode("hello\r\n"));

    expect(result.status).toBe("failed");
    expect(result.response).toContain("OVERQUOTA");
    await appender.close();
  });
});
