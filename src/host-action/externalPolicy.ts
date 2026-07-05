import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256, type HostActionCapabilitySpec } from "./capability.js";
import { DefaultDenyHostActionPolicy, StaticHostActionPolicy, type HostActionPolicySnapshot } from "./policy.js";
import { hostActionName } from "./types.js";

export interface ExternalPolicyPaths {
  readonly policyPath: string;
  readonly pinPath: string;
}

export function hostActionPolicyPaths(globalStoragePath: string): ExternalPolicyPaths {
  const root = path.join(globalStoragePath, "host-actions");
  return {
    policyPath: path.join(root, "policy.json"),
    pinPath: path.join(root, "policy.sha256"),
  };
}

export async function ensureDefaultExternalPolicy(input: {
  readonly paths: ExternalPolicyPaths;
  readonly version: string;
  readonly capabilities: readonly HostActionCapabilitySpec[];
  readonly allowedAgents: readonly string[];
}): Promise<void> {
  try {
    await readFile(input.paths.policyPath, "utf8");
    return;
  } catch {
    await mkdir(path.dirname(input.paths.policyPath), { recursive: true });
    const policy = {
      version: input.version,
      capabilities: input.capabilities,
      allowedAgents: input.allowedAgents,
    };
    await writeFile(input.paths.policyPath, `${JSON.stringify(policy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export async function loadPinnedExternalPolicy(paths: ExternalPolicyPaths): Promise<HostActionPolicySnapshot> {
  let raw: string;
  try {
    raw = await readFile(paths.policyPath, "utf8");
  } catch {
    return new DefaultDenyHostActionPolicy();
  }

  const hash = sha256(raw);
  const pinned = await readPinnedHash(paths.pinPath);
  if (pinned === undefined) {
    await mkdir(path.dirname(paths.pinPath), { recursive: true });
    await writeFile(paths.pinPath, `${hash}\n`, { encoding: "utf8", mode: 0o600 });
  } else if (pinned !== hash) {
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

async function readPinnedHash(pinPath: string): Promise<string | undefined> {
  try {
    const value = (await readFile(pinPath, "utf8")).trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
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
