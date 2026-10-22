import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
}

export function verifyRequestAuth(req: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) {
    // Agent is unconfigured: reject all privileged requests
    return false;
  }
  const token = extractBearerToken(req);
  if (!token) return false;
  return timingSafeEqual(token, expectedToken);
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): void {
  sendJson(res, statusCode, {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}
