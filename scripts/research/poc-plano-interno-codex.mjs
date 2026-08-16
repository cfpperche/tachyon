#!/usr/bin/env node
/**
 * Disposable probe for t-dfb70c / t-07ba11 (Codex 0.147.0).
 * Opens the same app-server transport Tachyon already uses
 * (`codex -s read-only -a untrusted app-server --stdio`) and records
 * turn/plan/updated vs turn/completed. Not a product reader.
 *
 * Usage:
 *   node scripts/research/poc-plano-interno-codex.mjs --handshake
 *   node scripts/research/poc-plano-interno-codex.mjs --turns induce,trivial
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEX = "codex";
const CODEX_ARGS = ["-s", "read-only", "-a", "untrusted", "app-server", "--stdio"];
const TURN_TIMEOUT_MS = 180_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

const PROMPTS = {
  induce: [
    "This is a protocol measurement, not real work.",
    "You MUST call the update_plan tool with exactly three steps about making a cup of tea.",
    "Do not execute any step. Do not run commands. Do not write files.",
    "After update_plan succeeds, reply with only the word PLANNED.",
  ].join(" "),
  trivial: [
    "Reply with only the word PONG.",
    "Do not use any tools. Do not call update_plan. Do not write a plan.",
  ].join(" "),
};

const args = process.argv.slice(2);
const handshakeOnly = args.includes("--handshake");
const turnsArg = argValue(args, "--turns") ?? (handshakeOnly ? "" : "induce,trivial");
const turnNames = turnsArg.split(",").map((s) => s.trim()).filter(Boolean);
for (const name of turnNames) {
  if (!PROMPTS[name]) {
    console.error(`unknown turn ${name}; known: ${Object.keys(PROMPTS).join(",")}`);
    process.exit(2);
  }
}

const runDir = join(tmpdir(), `poc-plano-interno-codex-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const cwd = join(runDir, "cwd");
mkdirSync(cwd);
const logPath = join(runDir, "events.jsonl");

const events = [];
const pending = new Map();
let nextId = 1;
let stdoutBuf = "";
let child;
let closing = false;

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  return argv[i + 1];
}

function nowMs() {
  return Date.now();
}

function record(kind, payload) {
  const row = { t: new Date().toISOString(), tMs: nowMs(), kind, ...payload };
  events.push(row);
  writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return row;
}

function send(payload) {
  record("out", { payload });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method, sentAt: nowMs() });
    send({ method, id, params });
  });
}

function notify(method, params) {
  send({ method, params });
}

function classifyIn(raw) {
  if (raw.id !== undefined && raw.method) return "server-request";
  if (raw.id !== undefined) return "response";
  if (raw.method) return "notification";
  return "other";
}

function handleServerRequest(raw) {
  const method = raw.method;
  record("server-request", { method, id: raw.id, params: raw.params });
  if (method === "currentTime/read") {
    send({ id: raw.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
    return;
  }
  if (
    method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval"
  ) {
    send({ id: raw.id, result: { decision: "decline" } });
    return;
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    send({
      id: raw.id,
      result: { decision: { denied: { rejection: "measurement probe denies side effects" } } },
    });
    return;
  }
  if (method === "item/tool/requestUserInput") {
    send({ id: raw.id, result: { answers: {} } });
    return;
  }
  send({
    id: raw.id,
    error: { code: -32601, message: `measurement probe does not handle ${method}` },
  });
}

function handleLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    record("parse-error", { line: line.slice(0, 400) });
    return;
  }
  const kind = classifyIn(raw);
  record("in", { inKind: kind, payload: raw });
  if (kind === "server-request") {
    handleServerRequest(raw);
    return;
  }
  if (kind === "response") {
    const waiter = pending.get(raw.id);
    if (!waiter) return;
    pending.delete(raw.id);
    waiter.resolve({ ...raw, elapsedMs: nowMs() - waiter.sentAt });
  }
}

function summarizeItem(item) {
  if (!item || typeof item !== "object") return item;
  const out = { type: item.type, id: item.id };
  if (item.type === "plan") out.text = item.text;
  if (item.type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text : "";
    out.text = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  if (item.status) out.status = item.status;
  return out;
}

function summarizePlanParams(params) {
  if (!params || typeof params !== "object") return params;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    explanation: params.explanation ?? null,
    planLength: Array.isArray(params.plan) ? params.plan.length : null,
    plan: params.plan,
    delta: typeof params.delta === "string" ? params.delta.slice(0, 200) : undefined,
    itemId: params.itemId,
  };
}

function waitForTurn(threadId, turnId, startedAt) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`turn ${turnId} timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    const check = () => {
      const completed = events.find((e) =>
        e.kind === "in"
        && e.payload?.method === "turn/completed"
        && e.payload?.params?.threadId === threadId
        && e.payload?.params?.turn?.id === turnId
      );
      if (!completed) return;
      clearTimeout(deadline);
      unwatch();
      resolve(completed);
    };

    const interval = setInterval(check, 50);
    const unwatch = () => clearInterval(interval);
    check();
  }).then((completed) => {
    const related = events.filter((e) => {
      if (e.kind !== "in") return false;
      const p = e.payload?.params;
      if (!p) return false;
      if (p.threadId === threadId && p.turnId === turnId) return true;
      if (p.threadId === threadId && p.turn?.id === turnId) return true;
      return false;
    });
    const methods = related
      .map((e) => e.payload?.method)
      .filter(Boolean);
    const planUpdated = related.filter((e) => e.payload?.method === "turn/plan/updated");
    const planDelta = related.filter((e) => e.payload?.method === "item/plan/delta");
    const planItems = related
      .filter((e) => e.payload?.method === "item/started" || e.payload?.method === "item/completed")
      .map((e) => e.payload?.params?.item)
      .filter((item) => item?.type === "plan");
    const firstPlan = planUpdated[0];
    const turn = completed.payload.params.turn;
    const items = Array.isArray(turn.items) ? turn.items.map(summarizeItem) : [];
    const planItemsInTurn = items.filter((item) => item.type === "plan");
    return {
      threadId,
      turnId,
      status: turn.status,
      durationMs: turn.durationMs ?? (completed.tMs - startedAt),
      firstPlanUpdatedMs: firstPlan ? firstPlan.tMs - startedAt : null,
      planUpdatedCount: planUpdated.length,
      planDeltaCount: planDelta.length,
      planItemLifecycleCount: planItems.length,
      planItemsInCompletedTurn: planItemsInTurn.length,
      emptyList: planUpdated.some((e) => Array.isArray(e.payload.params.plan) && e.payload.params.plan.length === 0),
      muteChannel: planUpdated.length === 0,
      methods: [...new Set(methods)],
      plans: planUpdated.map((e) => summarizePlanParams(e.payload.params)),
      deltas: planDelta.map((e) => summarizePlanParams(e.payload.params)),
      completedItems: items,
      error: turn.error ?? null,
    };
  });
}

async function runTurn(threadId, name) {
  const startedAt = nowMs();
  const resp = await request("turn/start", {
    threadId,
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
    input: [{ type: "text", text: PROMPTS[name] }],
  });
  if (resp.error) {
    throw new Error(`turn/start ${name} failed: ${JSON.stringify(resp.error)}`);
  }
  const turnId = resp.result?.turn?.id;
  if (!turnId) throw new Error(`turn/start ${name} returned no turn.id`);
  record("turn-accepted", { name, threadId, turnId, elapsedMs: resp.elapsedMs });
  const summary = await waitForTurn(threadId, turnId, startedAt);
  record("turn-summary", { name, summary });
  return { name, ...summary };
}

function shutdown() {
  if (closing) return;
  closing = true;
  try { child.stdin.end(); } catch { /* ignore */ }
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }, 400).unref();
}

async function main() {
  const version = await new Promise((resolve, reject) => {
    const p = spawn(CODEX, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => { out += c; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`codex --version exited ${code}`));
    });
  });

  const spawnEnv = { ...process.env };
  if (process.env.CODEX_HOME) spawnEnv.CODEX_HOME = process.env.CODEX_HOME;
  child = spawn(CODEX, CODEX_ARGS, {
    cwd,
    env: spawnEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    record("stderr", { text: String(chunk).slice(0, 2000) });
  });
  child.on("close", (code, signal) => {
    record("child-close", { code, signal });
  });
  process.on("exit", shutdown);
  process.on("SIGINT", () => { shutdown(); process.exit(130); });

  const init = await Promise.race([
    request("initialize", {
      clientInfo: { name: "tachyon_poc_plano_interno", title: "t-dfb70c probe", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("initialize timeout")), HANDSHAKE_TIMEOUT_MS);
    }),
  ]);
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  notify("initialized", {});

  const invented = await request("turn/checklist/updated", { threadId: "invented", turnId: "invented" })
    .catch((err) => ({ error: { message: String(err) } }));
  record("negative-control-invented-method", {
    method: "turn/checklist/updated",
    error: invented.error ?? null,
    result: invented.result ?? null,
  });

  const account = await request("account/read", { refreshToken: false });
  const accountType = account.result?.account?.type ?? null;
  record("account-read", {
    accountType,
    requiresOpenaiAuth: account.result?.requiresOpenaiAuth ?? null,
    error: account.error ?? null,
  });
  if (accountType !== "chatgpt") {
    throw new Error(`not a ChatGPT session (accountType=${accountType}); refuse to spend a model turn`);
  }

  const thread = await request("thread/start", {
    cwd,
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  if (thread.error) throw new Error(`thread/start failed: ${JSON.stringify(thread.error)}`);
  const threadId = thread.result?.thread?.id;
  if (!threadId) throw new Error("thread/start returned no thread.id");

  const report = {
    measuredAt: new Date().toISOString(),
    version,
    spawn: [CODEX, ...CODEX_ARGS],
    runDir,
    logPath,
    handshakeOnly,
    initializeMs: init.elapsedMs,
    threadId,
    accountType,
    codexHome: process.env.CODEX_HOME ?? null,
    model: thread.result?.model ?? null,
    inventedMethod: {
      method: "turn/checklist/updated",
      rejected: Boolean(invented.error),
      error: invented.error ?? null,
    },
    turns: [],
  };

  if (!handshakeOnly) {
    for (const name of turnNames) {
      report.turns.push(await runTurn(threadId, name));
    }
  }

  console.log(JSON.stringify(report, null, 2));
  shutdown();
  setTimeout(() => process.exit(0), 600);
}

main().catch((err) => {
  console.error(err);
  try {
    record("fatal", { message: String(err.stack || err) });
    console.error(`log: ${logPath}`);
  } catch { /* ignore */ }
  shutdown();
  process.exit(1);
});
