import crypto from "node:crypto";
import { parseDocument } from "yaml";
import {
  closeCanonicalAgentProfile,
  readAgentProfileReference,
  readCanonicalAgentProfile,
} from "../config/agentProfileReader.js";
import { agentProfileSchemaV1, type AgentProfileReferenceV1 } from "../config/agentProfileSchema.js";
// t-d48775 — the file name and the two limits moved to `agentInstructionsDocument.ts` so the WRITER
// (Agent Studio, host and webview) and this reader share one definition. Re-exported because this
// module was their published home and several callers import them from here.
export {
  PERSISTENT_INSTRUCTIONS_FILE_NAME,
  PERSISTENT_INSTRUCTIONS_MAX_BYTES,
  PERSISTENT_INSTRUCTIONS_MAX_CHARS,
} from "../config/agentInstructionsDocument.js";
import {
  PERSISTENT_INSTRUCTIONS_FILE_NAME,
  PERSISTENT_INSTRUCTIONS_MAX_BYTES,
  PERSISTENT_INSTRUCTIONS_MAX_CHARS,
} from "../config/agentInstructionsDocument.js";

export class PersistentInstructionsError extends Error {
  constructor(readonly code: "instructions/invalid" | "instructions/unauthorized" | "instructions/cas" | "instructions/unsafe" | "instructions/missing", message: string) {
    super(message);
    this.name = "PersistentInstructionsError";
  }
}

export interface ResolvedPersistentInstructions {
  referenceId: string;
  source: string;
  body: string;
  bytes: Buffer;
  sha256: string;
  chars: number;
}

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validateBytes(bytes: Buffer): { body: string; chars: number; sha256: string } {
  if (bytes.length === 0 || bytes.length > PERSISTENT_INSTRUCTIONS_MAX_BYTES) {
    throw new PersistentInstructionsError("instructions/invalid", `Persistent Instructions must contain 1-${PERSISTENT_INSTRUCTIONS_MAX_BYTES} UTF-8 bytes`);
  }
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new PersistentInstructionsError("instructions/invalid", `Persistent Instructions must be valid UTF-8: ${String(error)}`); }
  if (body.includes("\0") || body.trim().length === 0) throw new PersistentInstructionsError("instructions/invalid", "Persistent Instructions must contain non-whitespace text without NUL bytes");
  const chars = Array.from(body).length;
  if (chars > PERSISTENT_INSTRUCTIONS_MAX_CHARS) {
    throw new PersistentInstructionsError("instructions/invalid", `Persistent Instructions exceed ${PERSISTENT_INSTRUCTIONS_MAX_CHARS} Unicode scalar values`);
  }
  return { body, chars, sha256: digest(bytes) };
}

function selectedReference(workspaceRoot: string, agentName: string, agentId: string, referenceId: string): {
  source: NonNullable<ReturnType<typeof readCanonicalAgentProfile>>;
  reference: AgentProfileReferenceV1;
} {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) throw new PersistentInstructionsError("instructions/missing", `Canonical profile is missing for '${agentName}'`);
  try {
    const document = parseDocument(source.text, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
    const parsed = agentProfileSchemaV1.safeParse(document.toJS());
    if (!parsed.success || parsed.data.agentId !== agentId) throw new Error("profile identity does not match agentId");
    const reference = parsed.data.references?.find((candidate) => candidate.id === referenceId);
    if (!reference || reference.kind !== "instructions" || reference.scope !== "profile" || reference.owner !== agentId
      || reference.mode !== "pinned" || reference.path !== PERSISTENT_INSTRUCTIONS_FILE_NAME || !reference.sha256) {
      throw new Error("instructions selector is not the canonical pinned profile reference");
    }
    return { source, reference };
  } catch (error) {
    closeCanonicalAgentProfile(source);
    throw new PersistentInstructionsError("instructions/invalid", `Invalid Persistent Instructions activation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolvePersistentInstructions(input: {
  workspaceRoot: string;
  agentName: string;
  agentId: string;
  referenceId: string;
  subjectId: string;
  expectedPath: string;
  expectedProfileSha256: string;
  expectedSha256: string;
}): ResolvedPersistentInstructions {
  const selected = selectedReference(input.workspaceRoot, input.agentName, input.agentId, input.referenceId);
  try {
    if (selected.source.sha256 !== input.expectedProfileSha256) {
      throw new PersistentInstructionsError("instructions/cas", "Canonical profile bytes do not match active profile authority");
    }
    if (input.subjectId !== selected.reference.id || input.expectedPath !== selected.reference.path
      || selected.reference.sha256 !== input.expectedSha256) {
      throw new PersistentInstructionsError("instructions/cas", "Persistent Instructions selector digest does not match active formation authority");
    }
    const file = readAgentProfileReference(selected.source, selected.reference.path, input.expectedSha256);
    const validated = validateBytes(file.bytes);
    return {
      referenceId: selected.reference.id,
      source: `.tachyon/agents/${input.agentName}/${selected.reference.path}`,
      body: validated.body,
      bytes: Buffer.from(file.bytes),
      sha256: validated.sha256,
      chars: validated.chars,
    };
  } finally {
    closeCanonicalAgentProfile(selected.source);
  }
}
