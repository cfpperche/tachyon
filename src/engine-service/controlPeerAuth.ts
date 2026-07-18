import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const CONTROL_NONCE_BYTES = 32;

export function controlNoncePath(socketPath: string): string {
  return `${socketPath}.nonce`;
}

export function createControlNonce(socketPath: string): string {
  const nonce = randomBytes(CONTROL_NONCE_BYTES).toString("base64url");
  const noncePath = controlNoncePath(socketPath);
  const fd = fs.openSync(noncePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${nonce}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return nonce;
}

export function readControlNonce(socketPath: string): string {
  const noncePath = controlNoncePath(socketPath);
  const stat = fs.lstatSync(noncePath);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("persistent engine control nonce file is unsafe");
  }
  const nonce = fs.readFileSync(noncePath, "utf8").trim();
  if (!isControlNonce(nonce)) throw new Error("persistent engine control nonce is invalid");
  return nonce;
}

export function controlNonceMatches(expected: string, actual: unknown): boolean {
  if (!isControlNonce(actual)) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function isControlNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
