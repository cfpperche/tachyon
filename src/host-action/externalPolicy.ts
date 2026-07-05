import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256, type HostActionCapabilitySpec } from "./capability.js";
import { DefaultDenyHostActionPolicy, StaticHostActionPolicy, type HostActionPolicySnapshot } from "./policy.js";
import { hostActionName } from "./types.js";

export interface ExternalPolicyPaths {
  readonly policyPath: string;
}

export function hostActionPolicyPaths(globalStoragePath: string): ExternalPolicyPaths {
  const root = path.join(globalStoragePath, "host-actions");
  return {
    policyPath: path.join(root, "policy.json"),
  };
}

export async function restorePinnedExternalPolicy(paths: ExternalPolicyPaths, canonicalJson: string, expectedHash: string): Promise<"restored" | "unchanged"> {
  try {
    const existing = await readFile(paths.policyPath, "utf8");
    if (sha256(existing) === expectedHash) return "unchanged";
  } catch {
    // Missing/unreadable policy is restored from the build-pinned canonical source below.
  }
  if (sha256(canonicalJson) !== expectedHash) {
    throw new Error("canonical host-action policy does not match its source-pinned hash");
  }
  await mkdir(path.dirname(paths.policyPath), { recursive: true });
  await writeFile(paths.policyPath, canonicalJson, { encoding: "utf8", mode: 0o600 });
  return "restored";
}

export async function loadPinnedExternalPolicy(paths: ExternalPolicyPaths, expectedHash: string): Promise<HostActionPolicySnapshot> {
  let raw: string;
  try {
    raw = await readFile(paths.policyPath, "utf8");
  } catch {
    return new DefaultDenyHostActionPolicy();
  }

  const hash = sha256(raw);
  if (hash !== expectedHash) {
    return new DefaultDenyHostActionPolicy();
  }

  const parsed = safeParseExternalPolicy(raw);
  if (!parsed) return new DefaultDenyHostActionPolicy();
  return new StaticHostActionPolicy({
    version: parsed.version,
    hash,
    capabilities: parsed.capabilities,
    allowedAgents: parsed.allowedAgents,
  });
}

function safeParseExternalPolicy(raw: string): { version: string; capabilities: HostActionCapabilitySpec[]; allowedAgents: string[] } | undefined {
  try {
    return parseExternalPolicy(raw);
  } catch {
    return undefined;
  }
}

function parseExternalPolicy(raw: string): { version: string; capabilities: HostActionCapabilitySpec[]; allowedAgents: string[] } | undefined {
  const value = JSON.parse(raw) as Partial<{
    version: unknown;
    capabilities: unknown;
    allowedAgents: unknown;
  }>;
  if (typeof value.version !== "string" || !Array.isArray(value.capabilities) || !Array.isArray(value.allowedAgents)) {
    return undefined;
  }
  const capabilities = value.capabilities.map(parseCapability);
  if (capabilities.some((capability) => capability === undefined)) return undefined;
  const allowedAgents = value.allowedAgents.filter((agent): agent is string => typeof agent === "string" && agent.length > 0);
  return { version: value.version, capabilities: capabilities as HostActionCapabilitySpec[], allowedAgents };
}

function parseCapability(value: unknown): HostActionCapabilitySpec | undefined {
  const record = value as Partial<HostActionCapabilitySpec> | undefined;
  if (!record || typeof record.id !== "string" || typeof record.action !== "string" || typeof record.command !== "string") return undefined;
  if (!record.args || !Array.isArray(record.effects) || !record.risk_tier) return undefined;
  return {
    id: record.id,
    action: hostActionName(record.action),
    command: record.command,
    args: record.args,
    effects: record.effects,
    risk_tier: record.risk_tier,
  } as HostActionCapabilitySpec;
}
