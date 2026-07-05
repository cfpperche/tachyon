import crypto from "node:crypto";
import { HostActionError, type HostActionEffect, type HostActionName, type HostActionRiskTier } from "./types.js";

export type JsonPrimitiveType = "string" | "number" | "integer" | "boolean" | "null";

export type ClosedJsonSchema =
  | { readonly type: JsonPrimitiveType; readonly enum?: readonly unknown[]; readonly maxLength?: number }
  | {
      readonly type: "array";
      readonly items: ClosedJsonSchema;
      readonly maxItems?: number;
    }
  | {
      readonly type: "object";
      readonly properties?: Readonly<Record<string, ClosedJsonSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: false;
    };

export interface HostActionCapabilitySpec {
  readonly id: string;
  readonly action: HostActionName;
  readonly command: string;
  readonly args: { readonly schema: ClosedJsonSchema };
  readonly effects: readonly HostActionEffect[];
  readonly risk_tier: HostActionRiskTier;
}

export interface ValidatedHostActionArgs {
  readonly value: unknown;
  readonly canonical: string;
  readonly hash: string;
}

export interface CapabilityValidationOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_BYTES = 8192;
const DEFAULT_MAX_DEPTH = 8;

export function descriptorHash(spec: HostActionCapabilitySpec): string {
  return sha256(canonicalJson({
    id: spec.id,
    action: spec.action,
    command: spec.command,
    args: spec.args,
    effects: [...spec.effects].sort(),
    risk_tier: spec.risk_tier,
  }));
}

export function validateCapabilityArgs(
  spec: HostActionCapabilitySpec,
  args: unknown,
  options: CapabilityValidationOptions = {},
): ValidatedHostActionArgs {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const normalized = normalizeJsonValue(args ?? {}, 0, maxDepth);
  validateAgainstSchema(normalized, spec.args.schema, "$", maxDepth);
  const canonical = canonicalJson(normalized);
  if (Buffer.byteLength(canonical, "utf8") > maxBytes) {
    throw new HostActionError("args_invalid", "Host action args exceed the maximum encoded size");
  }
  return { value: normalized, canonical, hash: sha256(canonical) };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortForCanonicalJson(record[key])]));
  }
  return value;
}

function normalizeJsonValue(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) {
    throw new HostActionError("args_invalid", "Host action args exceed the maximum nesting depth");
  }
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || value === undefined) {
    throw new HostActionError("args_invalid", "Host action args must be JSON values without callbacks");
  }
  if (typeof value === "string") {
    const normalized = value.normalize("NFC");
    if (/^\s*command:/i.test(normalized)) {
      throw new HostActionError("args_invalid", "command: URI values are not allowed in host action args");
    }
    return normalized;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new HostActionError("args_invalid", "Host action numeric args must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item, depth + 1, maxDepth));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [rawKey, child] of Object.entries(value)) {
      const key = rawKey.normalize("NFC");
      if (/^commands?$/i.test(key) || /Command$/.test(key)) {
        throw new HostActionError("args_invalid", "Nested command-bearing fields are not allowed in host action args");
      }
      out[key] = normalizeJsonValue(child, depth + 1, maxDepth);
    }
    return out;
  }
  throw new HostActionError("args_invalid", "Unsupported host action arg value");
}

function validateAgainstSchema(value: unknown, schema: ClosedJsonSchema, path: string, maxDepth: number, depth = 0): void {
  if (depth > maxDepth) {
    throw new HostActionError("args_invalid", `${path} exceeds the maximum schema depth`);
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HostActionError("args_invalid", `${path} must be an object`);
    }
    if (schema.additionalProperties !== false) {
      throw new HostActionError("args_invalid", `${path} schema must be closed`);
    }
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new HostActionError("args_invalid", `Unknown host action arg field: ${path}.${key}`);
      }
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        throw new HostActionError("args_invalid", `Missing required host action arg field: ${path}.${key}`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        validateAgainstSchema(record[key], childSchema, `${path}.${key}`, maxDepth, depth + 1);
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new HostActionError("args_invalid", `${path} must be an array`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new HostActionError("args_invalid", `${path} has too many items`);
    }
    value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`, maxDepth, depth + 1));
    return;
  }
  if (!primitiveMatches(value, schema.type)) {
    throw new HostActionError("args_invalid", `${path} must be ${schema.type}`);
  }
  if ("maxLength" in schema && schema.maxLength !== undefined && typeof value === "string" && value.length > schema.maxLength) {
    throw new HostActionError("args_invalid", `${path} exceeds maximum length`);
  }
  if (schema.enum && !schema.enum.some((item) => item === value)) {
    throw new HostActionError("args_invalid", `${path} is not one of the allowed values`);
  }
}

function primitiveMatches(value: unknown, type: JsonPrimitiveType): boolean {
  if (type === "integer") {
    return Number.isInteger(value);
  }
  if (type === "null") {
    return value === null;
  }
  return typeof value === type;
}
