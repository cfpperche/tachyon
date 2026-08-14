import {
  MAX_HANDOFF_ADDITIONAL_INSTRUCTION,
  MAX_HANDOFF_TEMPORARY_ARGS,
  normalizeAdditionalInstruction,
  normalizeHandoffDistillArgs,
  resolveHandoffDistillProfile,
} from "@tachyon/shared/handoff/distill.js";

const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export type HandoffDistillInputV1 =
  | { mode: "existing"; agent: string; instructions?: string }
  | { mode: "adhoc"; profileId: string; args?: string; instructions?: string };

/** Strict wire validator. UI normalization happens before this boundary; the daemon never truncates intent. */
export function isHandoffDistillInputV1(value: unknown): value is HandoffDistillInputV1 {
  if (!isRecord(value) || (value.mode !== "existing" && value.mode !== "adhoc")) return false;
  if (!isOptionalInstruction(value.instructions)) return false;
  if (value.mode === "existing") {
    return hasOnlyKeys(value, ["mode", "agent", ...(value.instructions === undefined ? [] : ["instructions"])])
      && typeof value.agent === "string"
      && AGENT_NAME_RE.test(value.agent);
  }
  return hasOnlyKeys(value, [
    "mode",
    "profileId",
    ...(value.args === undefined ? [] : ["args"]),
    ...(value.instructions === undefined ? [] : ["instructions"]),
  ])
    && typeof value.profileId === "string"
    && resolveHandoffDistillProfile(value.profileId) !== undefined
    && (value.args === undefined
      || (typeof value.args === "string"
        && value.args.length > 0
        && value.args.length <= MAX_HANDOFF_TEMPORARY_ARGS
        && normalizeHandoffDistillArgs(value.args) === value.args));
}

export function parseHandoffDistillInputV1(value: unknown): HandoffDistillInputV1 {
  if (!isHandoffDistillInputV1(value)) throw new Error("invalid handoff distillation input");
  return value.mode === "existing"
    ? { mode: "existing", agent: value.agent, ...(value.instructions === undefined ? {} : { instructions: value.instructions }) }
    : {
        mode: "adhoc",
        profileId: value.profileId,
        ...(value.args === undefined ? {} : { args: value.args }),
        ...(value.instructions === undefined ? {} : { instructions: value.instructions }),
      };
}

function isOptionalInstruction(value: unknown): boolean {
  return value === undefined
    || (typeof value === "string"
      && value.length > 0
      && value.length <= MAX_HANDOFF_ADDITIONAL_INSTRUCTION
      && normalizeAdditionalInstruction(value) === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
