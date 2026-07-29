// From worker-mailer v1.2.1 (MIT, © zou-yu). BlockingQueue removed — auto-email
// sends sequentially on a pooled session, so nothing queues in the library.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export function encode(data: string): Uint8Array {
  return encoder.encode(data);
}

export function decode(data: Uint8Array): string {
  return decoder.decode(data);
}

export async function execTimeout<T>(promise: Promise<T>, ms: number, error: Error): Promise<T> {
  return Promise.race<T>([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(error), ms)),
  ]);
}

export function encodeQuotedPrintable(text: string, lineLength = 76): string {
  const bytes = encode(text);
  let result = "";
  let currentLineLength = 0;
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i]!;
    let encoded: string | undefined;

    if (byte === 0x0a) {
      result += "\r\n";
      currentLineLength = 0;
      i++;
      continue;
    } else if (byte === 0x0d) {
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0a) {
        result += "\r\n";
        currentLineLength = 0;
        i += 2;
        continue;
      }
      encoded = "=0D";
    }

    if (encoded === undefined) {
      const isWhitespace = byte === 0x20 || byte === 0x09;
      const nextIsLineBreak =
        i + 1 >= bytes.length || bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d;
      const needsEncoding =
        (byte < 32 && !isWhitespace) ||
        byte > 126 ||
        byte === 61 ||
        (isWhitespace && nextIsLineBreak);
      encoded = needsEncoding
        ? `=${byte.toString(16).toUpperCase().padStart(2, "0")}`
        : String.fromCharCode(byte);
    }

    // Reserve 3 characters for a potential '=XX' at the line end.
    if (currentLineLength + encoded.length > lineLength - 3) {
      result += "=\r\n";
      currentLineLength = 0;
    }

    result += encoded;
    currentLineLength += encoded.length;
    i++;
  }

  return result;
}
