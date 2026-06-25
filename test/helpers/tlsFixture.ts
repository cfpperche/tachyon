/**
 * Test-only TLS fixture (spec 265). Mint an EPHEMERAL self-signed cert via the system `openssl`
 * into a tmp dir, read the PEMs, delete the files. Nothing is committed — no private key ever
 * touches the repo (so the secrets hook stays quiet) and no cert library is added as a dependency.
 *
 * Returns null when openssl is unavailable, so a suite can `describe.skipIf(!tlsKeypair())` with an
 * honest reason rather than a silent pass. The self-signed cert IS its own CA: the fixture client
 * passes `ca: cert` to trust it, while PRODUCTION download code (no custom ca, rejectUnauthorized
 * defaulted true) correctly REJECTS it — which is exactly what H11 asks a test to prove.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface TlsKeypair {
  key: string;
  cert: string;
}

let memo: TlsKeypair | null | undefined;

export function tlsKeypair(): TlsKeypair | null {
  if (memo !== undefined) return memo;
  const dir = path.join(os.tmpdir(), `tachyon-tls-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", keyPath, "-out", certPath,
        "-days", "3650", "-nodes",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 20000 },
    );
    memo = { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
  } catch {
    memo = null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return memo;
}
