import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AuthorityIntegrity {
  version: 1;
  algorithm: "hmac-sha256";
  mac: string;
}

export interface AuthorityHead {
  revision: number;
  mac: string;
}

/** Host-custodied freshness anchor. `current` must read durable custody rather than a process cache;
 * `prepare` must durably replace the head before workspace commit. */
export interface AuthorityHeadPort {
  current(identity: string): Promise<AuthorityHead | undefined>;
  prepare(identity: string, next: AuthorityHead, expectedMac?: string): Promise<void>;
  /** Host-authorized lifecycle cleanup. When expectedMac is present, deletion is compare-and-swap. */
  retire?(identity: string, expectedMac?: string): Promise<void>;
  /** Atomically transfer one freshness identity during an owner rename. */
  move?(fromIdentity: string, toIdentity: string, next: AuthorityHead, expectedMac: string): Promise<void>;
  /** Migration-only: establish the very first head for `identity` at its already-existing revision N
   * (N >= 1) rather than the ordinary create's fixed revision 1. Must only succeed when there is no
   * current head; must be idempotent when the exact same head is supplied again; must never overwrite
   * or lower an existing, different head. Ordinary create/update never call this — they always go
   * through `prepare`, whose initial-head branch is still pinned to revision 1. */
  establishInitial?(identity: string, head: AuthorityHead): Promise<void>;
}

export type AuthorityRecord = { authorityIntegrity?: AuthorityIntegrity } & Record<string, unknown>;

/**
 * Bind a host-authenticated record to one canonical workspace. The HMAC key is
 * shared by this VS Code profile, so a type-only domain would let a valid record
 * be replayed from another workspace. Resolve symlinks when possible and hash
 * the absolute path so the scope itself does not disclose a local path.
 */
export function workspaceAuthorityDomain(kind: "legacy-delegation" | "canonical-delivery" | "agent-evolution", workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // A missing test/recovery root still gets a deterministic, workspace-bound scope.
  }
  const workspaceScope = crypto.createHash("sha256").update(canonical).digest("hex");
  return `${kind}:workspace-sha256:${workspaceScope}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("authority record contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("authority record must be JSON-serializable");
}

function unsigned(record: AuthorityRecord): Record<string, unknown> {
  const { authorityIntegrity: _integrity, ...payload } = record;
  return payload;
}

function macFor(record: AuthorityRecord, key: Buffer, domain: string): string {
  return crypto.createHmac("sha256", key)
    .update(`tachyon-authority-v1:${domain}\0`)
    .update(canonicalJson(unsigned(record)))
    .digest("hex");
}

export function sealAuthorityRecord<T extends AuthorityRecord>(record: T, key: Buffer, domain: string): T {
  return {
    ...record,
    authorityIntegrity: { version: 1, algorithm: "hmac-sha256", mac: macFor(record, key, domain) },
  };
}

export function verifyAuthorityRecord(record: AuthorityRecord, key: Buffer, domain: string): boolean {
  const integrity = record.authorityIntegrity;
  if (integrity?.version !== 1 || integrity.algorithm !== "hmac-sha256" || !/^[0-9a-f]{64}$/.test(integrity.mac)) return false;
  const expected = Buffer.from(macFor(record, key, domain), "hex");
  const observed = Buffer.from(integrity.mac, "hex");
  return observed.length === expected.length && crypto.timingSafeEqual(observed, expected);
}

export function authorityRecordMac(record: AuthorityRecord): string | undefined {
  const integrity = record.authorityIntegrity;
  return integrity?.version === 1 && integrity.algorithm === "hmac-sha256" && /^[0-9a-f]{64}$/.test(integrity.mac)
    ? integrity.mac
    : undefined;
}
