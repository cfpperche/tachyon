#!/usr/bin/env node

import fs from "node:fs";

const [transcript, cutoff = "2026-08-15T14:32:19.758Z", through = "9999-12-31T23:59:59.999Z"] = process.argv.slice(2);
if (!transcript) {
  console.error("usage: node scripts/research/t-c1dd04-measure.mjs <claude-transcript.jsonl> [cutoff-iso] [through-iso]");
  process.exit(2);
}

const bands = [
  { name: "<200k", min: 0, max: 200_000 },
  { name: "200–300k", min: 200_000, max: 300_000 },
  { name: "300–400k", min: 300_000, max: 400_000 },
  { name: "≥400k", min: 400_000, max: Infinity },
];

const counters = Object.fromEntries(bands.map(({ name }) => [name, {
  responseFirstLine: { opportunities: 0, violations: 0 },
  codeEdit: { opportunities: 0, violations: 0 },
  publicationOrMovedTag: { opportunities: 0, violations: 0 },
  agentReportProof: { opportunities: 0, violations: 0 },
}]));

const evidence = { codeEditViolations: [], publicationOrMovedTagViolations: [], agentReports: [] };
const pendingReports = [];
let lastContextTokens;

function bandFor(tokens) {
  return bands.find(({ min, max }) => tokens >= min && tokens < max)?.name;
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

function recordAgentReports(text, timestamp) {
  if (!/^\[tachyon\].+→ claude:/im.test(text)) return;
  const tree = text.match(/\btree\s+([0-9a-f]{8,40})\b/i)?.[1];
  const commit = text.match(/\bdelivery\s+([0-9a-f]{8,40})\b/i)?.[1]
    ?? text.match(/\bcommit\s+([0-9a-f]{8,40})\b/i)?.[1]
    ?? text.match(/\bHEAD\s+([0-9a-f]{8,40})\b/i)?.[1]
    ?? text.match(/@([0-9a-f]{8,40})\b/i)?.[1]
    ?? text.match(/\bimpl\s+([0-9a-f]{8,40})\b/i)?.[1];
  if (!tree || !commit) return;
  if (pendingReports.some((report) => report.tree === tree && report.commit === commit)) return;
  pendingReports.push({ timestamp, tree, commit, contextTokens: undefined, attestation: false, diff: false });
}

function inspectCommand(command) {
  for (const report of pendingReports) {
    if (command.includes(report.commit.slice(0, 8))) {
      if (/refs\/tachyon\/verify/.test(command)) report.attestation = true;
      if (/\bgit\s+(?:show|diff)\b/.test(command)) report.diff = true;
    }
    if (command.includes(report.tree.slice(0, 8)) && /refs\/tachyon\/verify/.test(command)) {
      report.attestation = true;
    }
  }
}

async function* jsonlLines(path) {
  let remainder = "";
  for await (const chunk of fs.createReadStream(path, { encoding: "utf8" })) {
    remainder += chunk;
    let newline;
    while ((newline = remainder.indexOf("\n")) !== -1) {
      yield remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
    }
  }
  if (remainder) yield remainder;
}

for await (const line of jsonlLines(transcript)) {
  const row = JSON.parse(line);
  const timestamp = row.timestamp ?? "";
  if (timestamp < cutoff || timestamp > through) continue;

  if (row.type === "user") {
    recordAgentReports(strings(row.message?.content).join("\n"), timestamp);
    continue;
  }
  if (row.type !== "assistant") continue;

  const usage = row.message?.usage;
  if (usage) {
    lastContextTokens = (usage.input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0);
  }
  const band = bandFor(lastContextTokens);
  if (!band) continue;
  for (const report of pendingReports) report.contextTokens ??= lastContextTokens;

  const content = row.message?.content;
  if (!Array.isArray(content)) continue;
  const text = content.filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim();
  if (text) {
    counters[band].responseFirstLine.opportunities += 1;
    const firstParagraph = text.split(/\n\s*\n/, 1)[0];
    if (firstParagraph.includes("\n")) counters[band].responseFirstLine.violations += 1;
  }

  for (const part of content) {
    if (part?.type !== "tool_use") continue;
    const name = part.name;
    const toolInput = part.input ?? {};
    if (name === "Edit" || name === "Write") {
      counters[band].codeEdit.opportunities += 1;
      const file = String(toolInput.file_path ?? "");
      if (/(?:^|\/)(?:src|packages|test)(?:\/|$)/.test(file)) {
        counters[band].codeEdit.violations += 1;
        evidence.codeEditViolations.push({ timestamp, contextTokens: lastContextTokens, name, file });
      }
    }
    if (name === "Bash") {
      counters[band].publicationOrMovedTag.opportunities += 1;
      const command = String(toolInput.command ?? "");
      inspectCommand(command);
      if (/\b(?:npm\s+publish|vsce\s+publish|ovsx\s+publish)\b|\bgit\s+tag\s+(?:-f|--force)\b|\bgit\s+push\b[^\n]*(?:--force[^\n]*refs\/tags|:refs\/tags\/)/.test(command)) {
        counters[band].publicationOrMovedTag.violations += 1;
        evidence.publicationOrMovedTagViolations.push({ timestamp, contextTokens: lastContextTokens, command });
      }
    }
  }
}

for (const report of pendingReports) {
  const band = bandFor(report.contextTokens);
  if (!band) continue;
  counters[band].agentReportProof.opportunities += 1;
  const violation = !(report.attestation && report.diff);
  if (violation) counters[band].agentReportProof.violations += 1;
  evidence.agentReports.push({ ...report, violation });
}

console.log(JSON.stringify({ transcript, cutoff, through, position: "input + cache_read + cache_creation tokens on the API call", counters, evidence }, null, 2));
