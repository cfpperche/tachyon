/**
 * SDD 480 Phase 5 — dogfood the execution graph against REAL operating-system objects.
 *
 * Real means real: a real tmux server, a real child process that really gets reparented when its
 * parent dies, the real running systemd unit, and the real production modules — `mintExecution`,
 * `sealExecutionEvent`, `ExecutionLedger`, `projectExecutions`, `buildExecutionGraphVm`. Nothing here
 * is a stand-in for the thing it is testing.
 *
 * Two boundaries this deliberately respects:
 *  - It NEVER touches the live fleet. Anything it creates goes on its own tmux socket and its own
 *    storage root; the workspace's agents and engine are only ever READ. A dogfood that disturbs the
 *    fleet it is measuring is not evidence, it is an incident.
 *  - It starts NO paid model call. The processes it spawns are `sleep` and `sh`, because the claim
 *    under test is about identity and attribution, not about anything a model would say.
 *
 * Run: npm run dogfood -- execution-graph
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mintExecution, readCarriedExecution, attributionFor, EXECUTION_ID_ENV, EXECUTION_AGENT_ENV } from "../../src/executionGraph/executionIdentity.js";
import { sealExecutionEvent, type SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";
import { openExecutionLedger, readExecutionEvents } from "../../src/executionGraph/executionLedger.js";
import { projectExecutions } from "../../src/executionGraph/executionProjection.js";
import { buildExecutionGraphVm, semanticParity } from "../../src/cockpit/executionGraphVm.js";

const SOCKET = `eg-dogfood-${process.pid}`;
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
function record(check: string, pass: boolean, detail: string): void {
  results.push({ check, pass, detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${check}\n      ${detail}\n`);
}

function tmux(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8", ...(opts.env ? { env: opts.env } : {}) }).trim();
}

async function main(): Promise<number> {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eg-dogfood-"));
  const ledger = openExecutionLedger({ storageRoot, workspaceHash: "dogfoodws" });

  // ── 1. A REAL tmux session, born carrying the identity ─────────────────────────────────────
  const paneExec = mintExecution({ agentId: "dogfood-agent", sessionId: "eg-pane", carrier: "carried" });
  // `-e KEY=value` is how the REAL TmuxService hands env to a new session (TmuxService.ts:898).
  // Passing it through the tmux CLIENT's own environment instead would prove nothing about the
  // production path — the server already exists and the session would not inherit it.
  const envFlags = Object.entries(paneExec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  tmux(["new-session", "-d", "-s", "eg-pane", ...envFlags, "sleep 120"]);
  const carriedBack = tmux(["show-environment", "-t", "eg-pane"]).split("\n")
    .reduce<Record<string, string>>((acc, line) => {
      const eq = line.indexOf("=");
      if (eq > 0) acc[line.slice(0, eq)] = line.slice(eq + 1);
      return acc;
    }, {});
  record(
    "a real tmux session carries the minted execution id",
    readCarriedExecution(carriedBack)?.executionId === paneExec.executionId,
    `tmux show-environment returned ${carriedBack[EXECUTION_ID_ENV] ?? "(nothing)"}`,
  );
  record(
    "the real pane's env attributes back as measured",
    attributionFor({ executionId: paneExec.executionId, agentId: "dogfood-agent" }, carriedBack) === "measured",
    `attributionFor(real pane env) = ${attributionFor({ executionId: paneExec.executionId, agentId: "dogfood-agent" }, carriedBack)}`,
  );
  ledger.record(sealExecutionEvent({
    kind: "spawn", node: "TmuxSession", state: "running", provenance: paneExec.provenance,
    correlation: paneExec.correlation, at: new Date().toISOString(),
    detail: { seam: "dogfood", socket: SOCKET, session: "eg-pane" },
  }));

  // ── 2. A REAL reparented process — the claim the whole spec rests on ────────────────────────
  // A child whose parent exits is adopted by init/systemd, so its PPID becomes a lie about origin.
  // The carried id is not, and that difference is measured here rather than asserted.
  const orphanExec = mintExecution({ agentId: "dogfood-agent", carrier: "carried" });
  // `detached: true` + `unref()` is what makes this a REAL orphan rather than a co-operative one.
  // Without it node keeps the child in its own process group and the grandchild dies with the
  // launcher — measured: the pid from `$!` was already ENOENT 500ms later. A test that "passed"
  // against a process that never outlived its parent would prove nothing about reparenting.
  const pidFile = path.join(storageRoot, "orphan.pid");
  const launcher = spawn("sh", ["-c", `sleep 90 & echo $! > ${pidFile}; exit 0`], {
    env: { ...process.env, ...orphanExec.env },
    detached: true,
    stdio: "ignore",
  });
  launcher.unref();
  await new Promise((r) => setTimeout(r, 800));
  const grandchildPid = (() => { try { return fs.readFileSync(pidFile, "utf8").trim(); } catch { return ""; } })();
  let reparentedPpid = "";
  let orphanEnv: Record<string, string> = {};
  let procReadError = "";
  try {
    reparentedPpid = (fs.readFileSync(`/proc/${grandchildPid}/status`, "utf8").match(/^PPid:\s*(\d+)/m) ?? [])[1] ?? "";
    orphanEnv = fs.readFileSync(`/proc/${grandchildPid}/environ`, "utf8").split("\0")
      .reduce<Record<string, string>>((acc, kv) => {
        const eq = kv.indexOf("=");
        if (eq > 0) acc[kv.slice(0, eq)] = kv.slice(eq + 1);
        return acc;
      }, {});
  } catch (err) {
    // Never swallow this: a silent catch here would report a HARNESS failure as though the product
    // could not attribute a reparented process, which is the opposite of the truth.
    procReadError = err instanceof Error ? err.message : String(err);
  }
  record(
    "a really reparented process lost its parent (PPID is no longer the launcher)",
    reparentedPpid !== "" && reparentedPpid !== String(launcher.pid),
    `pid ${grandchildPid} PPid=${reparentedPpid || "(unread)"}, launcher was ${launcher.pid}${procReadError ? ` — /proc read failed: ${procReadError}` : ""}`,
  );
  record(
    "…and is STILL attributable, because it carries the id it was born with",
    attributionFor({ executionId: orphanExec.executionId, agentId: "dogfood-agent" }, orphanEnv) === "measured",
    `/proc/${grandchildPid}/environ carried ${orphanEnv[EXECUTION_ID_ENV] ?? "(nothing)"} for agent ${orphanEnv[EXECUTION_AGENT_ENV] ?? "(none)"}`,
  );
  ledger.record(sealExecutionEvent({
    kind: "orphan", node: "Process", state: "orphaned", provenance: "measured",
    correlation: orphanExec.correlation, at: new Date().toISOString(),
    detail: { seam: "dogfood", pid: grandchildPid, reparentedTo: reparentedPpid },
  }));

  // ── 3. The REAL systemd unit, SHARED by every agent in the workspace ────────────────────────
  let unitName = "";
  try {
    unitName = execFileSync("sh", ["-c", "systemctl --user list-units --type=service --no-legend | grep -o 'tachyon-engine-[a-f0-9]*\\.service' | head -1"], { encoding: "utf8" }).trim();
  } catch { /* recorded below */ }
  // Three different agents claim the one unit — which is the case §4.3 exists for.
  for (const agent of ["dogfood-agent", "dogfood-agent-2", "dogfood-agent-3"]) {
    ledger.record(sealExecutionEvent({
      kind: "attach", node: "SystemdUnit", state: "shared",
      // `unproven` on purpose and it is the honest label: we did not start this unit and cannot
      // prove the running one is any execution of ours. It is recorded anyway.
      provenance: "unproven",
      correlation: { agentId: agent, executionId: "exec-real-engine-unit" },
      at: new Date().toISOString(),
      detail: { seam: "dogfood", unit: unitName || "(not found)" },
    }));
  }
  record("the real engine systemd unit was found to attach to", unitName !== "", `unit: ${unitName || "(none)"}`);

  // ── 4. A secret really handed to a real process ─────────────────────────────────────────────
  // Obviously fake, and that is deliberate: the pre-commit scanner refused the realistic-looking
  // literal I first used, and it was right to. `knownSecrets` redacts ANY literal it is handed, so
  // the code path under test is identical — and a fixture is never worth teaching a secret scanner
  // to look away. (The first slice of this SDD hit the same guard for the same reason.)
  const secret = "NOT-A-REAL-SECRET-dogfood-placeholder";
  const secretExec = mintExecution({ agentId: "dogfood-agent", carrier: "carried" });
  tmux(["new-session", "-d", "-s", "eg-secret", ...Object.entries(secretExec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), `sleep 60 --token ${secret}`]);
  ledger.record(sealExecutionEvent({
    kind: "spawn", node: "Process", state: "running", provenance: "measured",
    correlation: secretExec.correlation, at: new Date().toISOString(),
    detail: { cmd: `sleep 60 --token ${secret}` },
    knownSecrets: [secret],
  }));

  // ── 5. A real exit, with its code ───────────────────────────────────────────────────────────
  const exitExec = mintExecution({ agentId: "dogfood-agent", carrier: "carried" });
  const code = await new Promise<number>((resolve) => {
    const child = spawn("sh", ["-c", "exit 42"], { env: { ...process.env, ...exitExec.env }, stdio: "ignore" });
    child.once("close", (c) => resolve(c ?? -1));
  });
  ledger.record(sealExecutionEvent({
    kind: "exit", node: "Process", state: code === 0 ? "completed" : "failed", provenance: "measured",
    correlation: exitExec.correlation, at: new Date().toISOString(),
    detail: { exitCode: code },
  }));
  record("a real process exit was observed with its real code", code === 42, `sh -c 'exit 42' exited ${code}`);

  // ── 6. RESTART: a second ledger over the same file must rebuild the same graph ──────────────
  const liveGraph = projectExecutions(ledger.readAll());
  const reopened = openExecutionLedger({ storageRoot, workspaceHash: "dogfoodws" });
  const restartedGraph = projectExecutions(reopened.readAll());
  record(
    "restarting Control rebuilds the SAME graph from the ledger alone",
    JSON.stringify(restartedGraph) === JSON.stringify(liveGraph),
    `${liveGraph.executions.length} executions before, ${restartedGraph.executions.length} after`,
  );

  // ── 7. The invariants, read off the REAL rebuilt graph ──────────────────────────────────────
  const daemon = restartedGraph.executions.find((e) => e.executionId === "exec-real-engine-unit");
  record(
    "shared did NOT become ownership",
    !!daemon && daemon.shared && !daemon.exclusivelyOwned && daemon.claims.length === 3,
    `claims=${daemon?.claims.map((c) => c.agentId).join(",")} shared=${daemon?.shared} exclusivelyOwned=${daemon?.exclusivelyOwned}`,
  );
  record(
    "unproven stayed explicit rather than being promoted",
    !!daemon && daemon.unproven,
    `unproven=${daemon?.unproven}, provenances=${daemon?.claims.map((c) => c.provenance).join(",")}`,
  );
  const exited = restartedGraph.executions.find((e) => e.executionId === exitExec.executionId);
  record("exit and its code survive into the graph", exited?.exit?.code === "42", `exit=${JSON.stringify(exited?.exit)}`);
  const orphaned = restartedGraph.executions.find((e) => e.executionId === orphanExec.executionId);
  record("the orphaned process reads as orphaned", !!orphaned?.orphaned, `orphaned=${orphaned?.orphaned}`);

  // ── 8. No secret on disk ────────────────────────────────────────────────────────────────────
  const onDisk = fs.readFileSync(path.join(storageRoot, "events", "executions.jsonl"), "utf8");
  record(
    "the real secret handed to a real process is NOT on disk",
    !onDisk.includes(secret),
    `ledger is ${onDisk.length} bytes; the secret literal appears ${onDisk.split(secret).length - 1} times`,
  );
  record(
    "…and the surrounding command SURVIVED, so redaction did not become omission",
    onDisk.includes("--token"),
    `"--token" present in the sealed detail: ${onDisk.includes("--token")}`,
  );

  // ── 9. The surfaces, over this REAL data ────────────────────────────────────────────────────
  const vm = buildExecutionGraphVm({ projection: restartedGraph });
  const parity = semanticParity(vm);
  record("canvas and table agree over real data", parity.equal, `${parity.nodeIds.length} nodes vs ${parity.rowIds.length} rows`);
  record("the read-only reader sees the same events the ledger wrote", readExecutionEvents({ storageRoot, workspaceHash: "dogfoodws" }).length === ledger.readAll().length,
    `${readExecutionEvents({ storageRoot, workspaceHash: "dogfoodws" }).length} events read back`);

  // Emit the real VM so the harness can render THIS data rather than a synthetic fixture.
  const vmOut = path.join(process.cwd(), ".tachyon", "evidence", "t-d2bb2f");
  fs.mkdirSync(vmOut, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(vmOut, "real-execution-graph.vm.json"), JSON.stringify(vm, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(vmOut, "dogfood-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), { mode: 0o600 });

  // ── cleanup: kill only what THIS script created, on its own socket ──────────────────────────
  try { tmux(["kill-server"]); } catch { /* already gone */ }
  // `kill-server` stops the server but LEAVES the socket inode behind. Small, except this is the
  // host where a shared 7.9 GB /tmp filling up took down a whole suite (t-41f496) — the incident this
  // very spec cites as the reason retention is bounded. Leaving litter here would be the wrong lesson.
  try { fs.rmSync(path.join(os.tmpdir(), `tmux-${process.getuid?.() ?? 1000}`, SOCKET), { force: true }); } catch { /* best effort */ }
  try { execFileSync("sh", ["-c", `kill ${grandchildPid} 2>/dev/null || true`]); } catch { /* best effort */ }
  fs.rmSync(storageRoot, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) process.stdout.write(`FAILED: ${failed.map((f) => f.check).join("; ")}\n`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  process.stderr.write(`dogfood aborted: ${err instanceof Error ? err.stack : String(err)}\n`);
  try { execFileSync("tmux", ["-L", SOCKET, "kill-server"]); } catch { /* best effort */ }
  process.exitCode = 1;
});
