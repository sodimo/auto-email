import type { ConnectFn, SocketLike } from "../vendor/worker-mailer/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MockSocket extends SocketLike {
  /** Everything the client wrote, decoded, in order. */
  readonly writes: string[];
  readonly bytes: Uint8Array[];
  /** Queue a server response for the client to read. */
  push(text: string): void;
  closed: boolean;
}

/**
 * A socket whose "server" is a callback: it sees each chunk the client writes
 * and pushes responses back. Enough to drive real SMTP and IMAP dialogues
 * without a network, including the parts where ordering is the thing under
 * test (the IMAP synchronizing literal).
 */
export function createMockSocket(onWrite: (chunk: string, socket: MockSocket) => void): MockSocket {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const writes: string[] = [];
  const bytes: Uint8Array[] = [];

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const socket: MockSocket = {
    readable,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        bytes.push(chunk);
        const text = decoder.decode(chunk);
        writes.push(text);
        onWrite(text, socket);
      },
    }),
    opened: Promise.resolve(),
    writes,
    bytes,
    closed: false,
    push(text: string) {
      controller.enqueue(encoder.encode(text));
    },
    async close() {
      socket.closed = true;
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
    startTls() {
      return socket;
    },
  };

  return socket;
}

export function connectTo(socket: MockSocket): ConnectFn {
  return () => socket;
}

/** Lets a test wait for the client to reach a point in the dialogue. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

export interface SmtpScript {
  /** Capability line advertised after EHLO. */
  capabilities?: string;
  /** Override any single step's reply, e.g. { body: "451 try later\r\n" }. */
  replies?: Partial<Record<"auth" | "mail" | "rcpt" | "data" | "body", string>>;
}

/** A cooperative SMTP server: greets, advertises AUTH, and accepts everything. */
export function smtpServer(script: SmtpScript = {}): { socket: MockSocket; body: () => string } {
  let inBody = false;
  let body = "";
  // AUTH LOGIN is a three-step dialogue: challenge, username, password.
  let loginStep = 0;

  const socket = createMockSocket((chunk, s) => {
    if (inBody) {
      body += chunk;
      if (body.endsWith("\r\n.\r\n")) {
        inBody = false;
        s.push(script.replies?.body ?? "250 2.0.0 Ok: queued as 4Xy2\r\n");
      }
      return;
    }
    const line = chunk.trimEnd();
    if (loginStep === 1) {
      loginStep = 2;
      s.push("334 UGFzc3dvcmQ6\r\n");
    } else if (loginStep === 2) {
      loginStep = 0;
      s.push(script.replies?.auth ?? "235 2.7.0 Authentication succeeded\r\n");
    } else if (line.startsWith("EHLO")) {
      s.push(script.capabilities ?? "250-smtp.strato.com\r\n250-AUTH PLAIN LOGIN\r\n250 HELP\r\n");
    } else if (line.startsWith("HELO")) {
      s.push("250 smtp.strato.com\r\n");
    } else if (line === "AUTH LOGIN") {
      loginStep = 1;
      s.push("334 VXNlcm5hbWU6\r\n");
    } else if (line.startsWith("AUTH PLAIN")) {
      s.push(script.replies?.auth ?? "235 2.7.0 Authentication succeeded\r\n");
    } else if (line.startsWith("MAIL FROM")) {
      s.push(script.replies?.mail ?? "250 2.1.0 Ok\r\n");
    } else if (line.startsWith("RCPT TO")) {
      s.push(script.replies?.rcpt ?? "250 2.1.5 Ok\r\n");
    } else if (line === "DATA") {
      const reply = script.replies?.data ?? "354 End data with <CR><LF>.<CR><LF>\r\n";
      if (reply.startsWith("354")) inBody = true;
      s.push(reply);
    } else if (line === "QUIT") {
      s.push("221 2.0.0 Bye\r\n");
    }
  });

  socket.push("220 smtp.strato.com ESMTP ready\r\n");
  return { socket, body: () => body };
}
