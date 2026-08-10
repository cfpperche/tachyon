import fs from "node:fs";
import path from "node:path";
import type { ArtifactRef } from "../tasks/types.js";
import type { ValidationCandidate } from "./types.js";

const VALIDATION_PATTERNS = [
  /human dogfood/i,
  /dogfood(?:s)? pendente/i,
  /manual validation/i,
  /manual qa/i,
  /smoke test/i,
  /validar manualmente/i,
  /visual qa/i,
];

const CACHE_TTL_MS = 2500;
const discoveryCache = new Map<string, { expiresAt: number; candidates: ValidationCandidate[] }>();

export function discoverValidationCandidates(workspaceRoot: string, limit = 100): ValidationCandidate[] {
  const cacheKey = `${path.resolve(workspaceRoot)}\0${limit}`;
  const now = Date.now();
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.candidates.slice(0, limit);

  const out: ValidationCandidate[] = [];
  const add = (title: string, source_ref: ArtifactRef, excerpt: string, type = "dogfood"): void => {
    if (out.length >= limit) return;
    const key = `${source_ref.type}\0${source_ref.ref}\0${excerpt}`;
    if (out.some((c) => `${c.source_ref.type}\0${c.source_ref.ref}\0${c.excerpt}` === key)) return;
    out.push({ title, type, executor: "human", source_ref, excerpt });
  };

  scanJsonDir(path.join(workspaceRoot, ".tachyon", "tasks"), "task", add);
  scanPins(workspaceRoot, add);
  const candidates = out.slice(0, limit);
  discoveryCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, candidates });
  return candidates;
}

function scanJsonDir(dir: string, type: string, add: (title: string, sourceRef: ArtifactRef, excerpt: string, kind?: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    const text = safeRead(full);
    if (!text || !VALIDATION_PATTERNS.some((p) => p.test(text))) continue;
    const id = name.slice(0, -".json".length);
    add(`Validate ${id}`, { type, ref: id }, excerpt(text), "dogfood");
  }
}

function scanPins(root: string, add: (title: string, sourceRef: ArtifactRef, excerpt: string, kind?: string) => void): void {
  const pins = path.join(root, ".tachyon", "pins.json");
  const text = safeRead(pins);
  if (!text || !VALIDATION_PATTERNS.some((p) => p.test(text))) return;
  try {
    const rows = JSON.parse(text) as Array<{ id?: string; text?: string; detail?: boolean }>;
    for (const row of rows) {
      const hay = row.text ?? "";
      if (!row.id || !VALIDATION_PATTERNS.some((p) => p.test(hay))) continue;
      add(row.text?.slice(0, 120) || `Validate ${row.id}`, { type: "pin", ref: row.id }, hay, "dogfood");
    }
  } catch {
    add("Review validation-related pins", { type: "pins", ref: ".tachyon/pins.json" }, excerpt(text), "dogfood");
  }
}

function safeRead(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function excerpt(text: string): string {
  const line = text.split("\n").find((l) => VALIDATION_PATTERNS.some((p) => p.test(l))) ?? text;
  return line.trim().slice(0, 500);
}
