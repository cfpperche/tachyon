#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "problem"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          target: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
    mostImportant: { type: "string" },
  },
};

function excerpt(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function parseClaudeEnvelope(stdout) {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed?.type === "result") return parsed;
    } catch {
      // keep scanning
    }
  }
  throw new Error("Claude did not emit a result JSON envelope");
}

function parseStructuredResult(result) {
  if (typeof result === "object" && result !== null) return result;
  if (typeof result !== "string") throw new Error("Claude result is neither JSON object nor string");
  const trimmed = result.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("Claude result did not contain a JSON object");
  }
}

const [spec, plan] = await Promise.all([
  readFile("docs/specs/312-silent-persistence-hooks/spec.md", "utf8"),
  readFile("docs/specs/312-silent-persistence-hooks/plan.md", "utf8"),
]);

const prompt = [
  "You are running as a bounded Tachyon probe. Do NOT inspect the filesystem, run shell commands, browse, or use tools.",
  "Base your answer only on the TASK, CONTEXT, and CONSTRAINTS below. If the provided context is insufficient, say what is unverifiable instead of exploring.",
  "",
  "You are an INDEPENDENT, ADVERSARIAL reviewer. Find what is wrong, weak, missing, or over/under-engineered.",
  "",
  "TASK: Review the silent persistence hooks spec and plan for correctness risks.",
  "",
  `CONTEXT:\n--- spec.md ---\n${excerpt(spec, 6000)}\n--- plan.md ---\n${excerpt(plan, 6000)}`,
  "",
  'CONSTRAINTS: Return ONLY JSON. Do not mention reading files. If evidence is missing, put that in a finding.',
  "",
  'Return ONLY a JSON object: {"findings":[{"title","severity":"blocker|major|minor","target","problem","fix"}],"mostImportant"}.',
].join("\n");

const { stdout, stderr } = await execFileP(
  "claude",
  [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--safe-mode",
    "--no-session-persistence",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--json-schema",
    JSON.stringify(schema),
    "--max-budget-usd",
    "1.50",
  ],
  { timeout: 600_000, maxBuffer: 1024 * 1024 },
);

const envelope = parseClaudeEnvelope(stdout);
if (envelope.is_error) {
  throw new Error(`Claude returned error result: ${envelope.result || envelope.errors?.join("; ") || stderr}`);
}

const structured = parseStructuredResult(envelope.result);
if (!Array.isArray(structured.findings)) throw new Error("Structured result missing findings[]");

console.log(
  JSON.stringify(
    {
      ok: true,
      findings: structured.findings.length,
      costUsd: envelope.total_cost_usd,
      mostImportant: structured.mostImportant ?? null,
    },
    null,
    2,
  ),
);
