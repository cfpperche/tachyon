import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentNoopHostActionPort,
  FileHashChainAuditSink,
  HashChainAuditSink,
  HostActionBroker,
  HostActionError,
  StaticHostActionPolicy,
  hostActionName,
  type HostActionCallerResolver,
  type HostActionCapabilitySpec,
  type HostActionExecutionEnvelope,
  type HostActionPort,
  type HostActionPortResult,
} from "@tachyon/engine/host-action/index.js";

const reloadAction = hostActionName("reloadWindow");

const reloadSpec: HostActionCapabilitySpec = {
  id: "core.reloadWindow.v1",
  action: reloadAction,
  command: "reloadWindow",
  args: { schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  effects: ["host_lifecycle_disruptive", "destructive_interrupting"],
  risk_tier: "compound",
};

const callerResolver: HostActionCallerResolver = {
  resolve: () => ({ ok: true, caller: { kind: "agent", name: "hostActionCore" } }),
};

describe("host-action core conformance", () => {
  it("default-deny audits a denied attempt and does not execute", async () => {
    const audit = new HashChainAuditSink();
    const port = new AgentNoopHostActionPort();
    const broker = new HostActionBroker({ callerResolver, audit, port, randomId: () => "act-1" });

    await expect(broker.run({ action: reloadAction })).resolves.toMatchObject({
      ok: false,
      code: "capability_not_found",
      actionId: "act-1",
      auditSeq: 1,
      outcomeSeq: 2,
    });

    expect(port.envelopes).toHaveLength(0);
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0].payload).toMatchObject({ kind: "decision", allowed: false, denialCode: "capability_not_found" });
    expect(audit.records[1].payload).toMatchObject({ kind: "outcome", state: "denied" });
  });

  it("fsyncs the audit decision before dispatching to the adapter", async () => {
    const events: string[] = [];
    const audit = new HashChainAuditSink({
      durableFlush: (record) => {
        events.push(`flush:${record.payload.kind}:${record.seq}`);
      },
    });
    const port = new RecordingPort(() => {
      events.push("execute");
      return { state: "dispatched", receipt: "ok" };
    });
    const broker = allowBroker({ audit, port, randomId: () => "act-2" });

    await expect(broker.run({ action: reloadAction })).resolves.toMatchObject({ ok: true, auditSeq: 1, outcomeSeq: 2 });

    expect(events).toEqual(["flush:decision:1", "execute", "flush:outcome:2"]);
    expect(port.envelopes[0].decision).toMatchObject({
      requested_by: { kind: "agent", name: "hostActionCore" },
      policy_version: "policy-v1",
      policy_hash: "policy-hash-v1",
      spec_id: "core.reloadWindow.v1",
      executor_adapter: "recording",
    });
    expect(port.envelopes[0].argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(port.envelopes[0].descriptorHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects malformed args and common command-smuggling shapes without execution", async () => {
    const attempts = [
      { extra: true },
      { command: "anything" },
      { url: "command:workbench.action.reloadWindow" },
      { nested: { ok: true } },
      { cb: () => undefined },
    ];

    for (const [index, args] of attempts.entries()) {
      const audit = new HashChainAuditSink();
      const port = new AgentNoopHostActionPort();
      const broker = allowBroker({ audit, port, randomId: () => `bad-${index}` });

      await expect(broker.run({ action: reloadAction, args })).resolves.toMatchObject({ ok: false, code: "args_invalid" });
      expect(port.envelopes).toHaveLength(0);
      expect(audit.records[0].payload).toMatchObject({ kind: "decision", allowed: false, denialCode: "args_invalid" });
    }
  });

  it("canonicalizes equivalent args to the same payload hash", async () => {
    const action = hostActionName("openPanel");
    const spec: HostActionCapabilitySpec = {
      id: "core.openPanel.v1",
      action,
      command: "openPanel",
      args: {
        schema: {
          type: "object",
          properties: {
            label: { type: "string" },
            count: { type: "integer" },
          },
          required: ["label", "count"],
          additionalProperties: false,
        },
      },
      effects: ["ui"],
      risk_tier: "bounded",
    };
    const policy = new StaticHostActionPolicy({
      version: "policy-v2",
      hash: "policy-hash-v2",
      capabilities: [spec],
      allowedAgents: ["hostActionCore"],
    });
    const port = new AgentNoopHostActionPort();
    const broker = new HostActionBroker({ callerResolver, policy, audit: new HashChainAuditSink(), port, randomId: () => `canon-${port.envelopes.length}` });

    await expect(broker.run({ action, args: { count: 1, label: "Cafe\u0301" } })).resolves.toMatchObject({ ok: true });
    await expect(broker.run({ action, args: { label: "Caf\u00e9", count: 1 } })).resolves.toMatchObject({ ok: true });

    expect(port.envelopes[0].canonicalArgs).toBe('{"count":1,"label":"Café"}');
    expect(port.envelopes[0].argsHash).toBe(port.envelopes[1].argsHash);
  });

  it("fails closed when the adapter is unavailable", async () => {
    const audit = new HashChainAuditSink();
    const port = new AgentNoopHostActionPort({ available: false });
    const broker = allowBroker({ audit, port, randomId: () => "act-unavailable" });

    await expect(broker.run({ action: reloadAction })).resolves.toMatchObject({
      ok: false,
      code: "adapter_unavailable",
      auditSeq: 1,
      outcomeSeq: 2,
    });
    expect(port.envelopes).toHaveLength(0);
  });

  it("rejects policy version mismatch before execution", async () => {
    const audit = new HashChainAuditSink();
    const port = new AgentNoopHostActionPort();
    const broker = allowBroker({ audit, port, randomId: () => "act-policy-mismatch" });

    await expect(broker.run({ action: reloadAction, expectedPolicyVersion: "stale-policy" })).resolves.toMatchObject({
      ok: false,
      code: "policy_version_mismatch",
    });
    expect(port.envelopes).toHaveLength(0);
    expect(audit.records[0].payload).toMatchObject({ kind: "decision", allowed: false, denialCode: "policy_version_mismatch" });
  });

  it("records result_unknown as a failed broker result, not false success", async () => {
    const audit = new HashChainAuditSink();
    const port = new AgentNoopHostActionPort({ state: "result_unknown" });
    const broker = allowBroker({ audit, port, randomId: () => "act-unknown" });

    await expect(broker.run({ action: reloadAction })).resolves.toMatchObject({
      ok: false,
      code: "result_unknown",
      auditSeq: 1,
      outcomeSeq: 2,
    });
    expect(audit.records[1].payload).toMatchObject({ kind: "outcome", state: "result_unknown" });
  });

  it("records adapter failures after the pre-execute audit", async () => {
    const audit = new HashChainAuditSink();
    const port = new RecordingPort(() => {
      throw new HostActionError("adapter_failed", "adapter exploded");
    });
    const broker = allowBroker({ audit, port, randomId: () => "act-fail" });

    await expect(broker.run({ action: reloadAction })).resolves.toMatchObject({
      ok: false,
      code: "adapter_failed",
      auditSeq: 1,
      outcomeSeq: 2,
    });
    expect(audit.records[0].payload).toMatchObject({ kind: "decision", allowed: true });
    expect(audit.records[1].payload).toMatchObject({ kind: "outcome", state: "failed", code: "adapter_failed" });
  });

  it("models timeout as a conformance failure path", async () => {
    const audit = new HashChainAuditSink();
    const port = new RecordingPort(() => new Promise<HostActionPortResult>(() => undefined));
    const broker = allowBroker({ audit, port, randomId: () => "act-timeout" });

    await expect(broker.run({ action: reloadAction, timeoutMs: 1 })).resolves.toMatchObject({
      ok: false,
      code: "timeout",
      auditSeq: 1,
      outcomeSeq: 2,
    });
  });

  it("hash-chains audit records with monotonic sequence numbers", async () => {
    const audit = new HashChainAuditSink({ now: () => new Date("2026-07-05T00:00:00.000Z") });
    const broker = allowBroker({ audit, port: new AgentNoopHostActionPort(), randomId: () => "act-chain" });

    await broker.run({ action: reloadAction });

    expect(audit.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(audit.records[0].previous_hash).toBe("0".repeat(64));
    expect(audit.records[1].previous_hash).toBe(audit.records[0].event_hash);
    expect(audit.records[0].event_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can durably write the audit chain to an fsynced file sink", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "host-action-audit-"));
    try {
      const filePath = path.join(dir, "audit.jsonl");
      const audit = new FileHashChainAuditSink({ filePath, now: () => new Date("2026-07-05T00:00:00.000Z") });
      const broker = allowBroker({ audit, port: new AgentNoopHostActionPort(), randomId: () => "act-file-audit" });

      await expect(broker.run({ action: reloadAction })).resolves.toMatchObject({ ok: true });

      const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number; previous_hash: string; event_hash: string });
      expect(lines.map((line) => line.seq)).toEqual([1, 2]);
      expect(lines[1].previous_hash).toBe(lines[0].event_hash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues the durable audit chain when a file sink is reopened", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "host-action-audit-resume-"));
    try {
      const filePath = path.join(dir, "audit.jsonl");
      const first = new FileHashChainAuditSink({ filePath, now: () => new Date("2026-07-05T00:00:00.000Z") });
      const firstBroker = allowBroker({ audit: first, port: new AgentNoopHostActionPort(), randomId: () => "act-file-audit-1" });
      await expect(firstBroker.run({ action: reloadAction })).resolves.toMatchObject({ ok: true });

      const second = new FileHashChainAuditSink({ filePath, now: () => new Date("2026-07-05T00:00:01.000Z") });
      await second.appendOutcome({ kind: "outcome", actionId: "act-recovered", state: "reattached_verified" });

      const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number; previous_hash: string; event_hash: string });
      expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
      expect(lines[2].previous_hash).toBe(lines[1].event_hash);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

class RecordingPort implements HostActionPort {
  readonly adapterId = "recording";
  readonly available = true;
  readonly envelopes: HostActionExecutionEnvelope[] = [];
  private readonly handler: (envelope: HostActionExecutionEnvelope) => HostActionPortResult | Promise<HostActionPortResult>;

  constructor(handler: (envelope: HostActionExecutionEnvelope) => HostActionPortResult | Promise<HostActionPortResult>) {
    this.handler = handler;
  }

  async execute(envelope: HostActionExecutionEnvelope): Promise<HostActionPortResult> {
    this.envelopes.push(envelope);
    return this.handler(envelope);
  }
}

function allowBroker(input: {
  readonly audit: HashChainAuditSink;
  readonly port: HostActionPort;
  readonly randomId: () => string;
}): HostActionBroker {
  const policy = new StaticHostActionPolicy({
    version: "policy-v1",
    hash: "policy-hash-v1",
    capabilities: [reloadSpec],
    allowedAgents: ["hostActionCore"],
  });
  return new HostActionBroker({ callerResolver, policy, audit: input.audit, port: input.port, randomId: input.randomId });
}
