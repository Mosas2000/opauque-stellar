import type { IncomingMessage } from "node:http";

/** Stable error code returned to clients when a request body exceeds the configured limit. */
export const PAYLOAD_TOO_LARGE_CODE = "PAYLOAD_TOO_LARGE";

export class PayloadTooLargeError extends Error {
  readonly code = PAYLOAD_TOO_LARGE_CODE;
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`request body exceeds the ${limitBytes} byte limit`);
    this.limitBytes = limitBytes;
  }
}

/**
 * Reads and JSON-parses a request body while enforcing `maxBytes` as the chunks stream in,
 * instead of buffering the full payload before checking its size. Destroys the socket and
 * throws `PayloadTooLargeError` the moment the running total crosses the limit, so an
 * oversized body cannot consume unbounded memory even if the client keeps sending data.
 */
export async function readJsonLimited(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf: Buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
