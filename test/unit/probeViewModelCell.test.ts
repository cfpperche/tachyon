import { describe, expect, it } from "vitest";
import { buildProbeView, modelCell } from "../../src/probe/probeView.js";
import type { ProbeRunRecord } from "../../src/probe/ProbeStore.js";

/**
 * SDD 475 / t-3a3de1 — the Probes model column. The invariant under test: the cell only ever prints
 * an EFFECTIVE identifier, `unproven`, or `—`. A requested model must never appear where a reader
 * would take it for the model that answered — that would re-create the silent-fallback confusion
 * SDD 473/474 exist to remove.
 */

describe("probe model cell", () => {
  it("shows the effective identifier when the run proved it", () => {
    const cell = modelCell({
      status: "completed", requestedModel: "claude-opus-5",
      effectiveModel: "claude-opus-5-20260101", modelProof: "proven",
    });
    expect(cell).toEqual({
      model: "claude-opus-5-20260101",
      modelState: "proven",
      modelTitle: "requested and confirmed claude-opus-5-20260101",
    });
  });

  it("shows the effective identifier on a mismatch and names the requested one only in the title", () => {
    const cell = modelCell({
      status: "failed", requestedModel: "claude-opus-5",
      effectiveModel: "claude-haiku-4-5-20251001", modelProof: "mismatch",
    });
    expect(cell.model).toBe("claude-haiku-4-5-20251001");
    expect(cell.modelState).toBe("mismatch");
    expect(cell.modelTitle).toContain("requested claude-opus-5");
    // the cell text is the model that RAN, never the one that was asked for
    expect(cell.model).not.toContain("opus");
  });

  it("says unproven and never borrows the requested identifier", () => {
    const cell = modelCell({ status: "completed", requestedModel: "claude-opus-5", modelProof: "unproven" });
    expect(cell.model).toBe("unproven");
    expect(cell.modelState).toBe("unproven");
    // the requested model is context, not content
    expect(cell.model).not.toContain("claude-opus-5");
    expect(cell.modelTitle).toContain("claude-opus-5");
  });

  it("still reports what ran when no model was requested", () => {
    const cell = modelCell({ status: "completed", effectiveModel: "grok-4.5-build", modelProof: "not-requested" });
    expect(cell.model).toBe("grok-4.5-build");
    expect(cell.modelState).toBe("reported");
  });

  it("renders an em dash when nothing was requested and nothing reported", () => {
    const cell = modelCell({ status: "completed", modelProof: "not-requested" });
    expect(cell).toEqual({ model: "—", modelState: "none", modelTitle: "no model requested and none reported" });
  });

  it("asserts nothing while a run is still in flight", () => {
    const cell = modelCell({ status: "running", requestedModel: "claude-opus-5", modelProof: "unproven" });
    expect(cell.model).toBe("—");
    expect(cell.modelState).toBe("none");
    expect(cell.modelTitle).toContain("still running");
  });

  it("names the kind of evidence behind a verdict, so 'confirmed' is not over-read (SDD 476)", () => {
    const provider = modelCell({
      status: "completed", requestedModel: "claude-opus-5",
      effectiveModel: "claude-opus-5-20260101", modelProof: "proven", modelEvidence: "provider-usage",
    });
    expect(provider.modelTitle).toBe("requested and confirmed claude-opus-5-20260101 (provider usage)");

    const session = modelCell({
      status: "completed", requestedModel: "gpt-5.6-luna",
      effectiveModel: "gpt-5.6-luna", modelProof: "proven", modelEvidence: "session-record",
    });
    // A Codex verdict must not read as provider attestation — it is the runtime's own record.
    expect(session.modelTitle).toBe("requested and confirmed gpt-5.6-luna (runtime session record)");

    const mismatch = modelCell({
      status: "failed", requestedModel: "gpt-5.6-luna",
      effectiveModel: "gpt-5.6-sol", modelProof: "mismatch", modelEvidence: "session-record",
    });
    expect(mismatch.modelTitle).toContain("(runtime session record)");
  });

  it("says nothing about evidence when the run recorded none", () => {
    const cell = modelCell({
      status: "completed", requestedModel: "claude-opus-5",
      effectiveModel: "claude-opus-5-20260101", modelProof: "proven",
    });
    expect(cell.modelTitle).toBe("requested and confirmed claude-opus-5-20260101");
  });

  it("does not claim proven when the verdict says so but no identifier was stored", () => {
    // defensive: a proven verdict with no effective value cannot show one.
    const cell = modelCell({ status: "completed", requestedModel: "x", modelProof: "proven" });
    expect(cell.model).toBe("—");
    expect(cell.modelState).toBe("none");
  });
});

describe("probe view rows carry the model cell", () => {
  function record(over: Partial<ProbeRunRecord> = {}): ProbeRunRecord {
    return {
      runId: "probe-1", runtime: "claude", createdAt: new Date(0).toISOString(),
      status: "completed", ...over,
    } as ProbeRunRecord;
  }

  it("derives the cell for every row without leaking raw provenance into the renderer", () => {
    const view = buildProbeView([
      record({ runId: "probe-a", requestedModel: "claude-opus-5", effectiveModel: "claude-opus-5-20260101", modelProof: "proven" }),
      record({ runId: "probe-b", requestedModel: "claude-opus-5", effectiveModel: "claude-haiku-4-5-20251001", modelProof: "mismatch", status: "failed" }),
      record({ runId: "probe-c", requestedModel: "gpt-5.6", modelProof: "unproven", status: "failed" }),
    ], 0);
    expect(view.rows.map((r) => [r.model, r.modelState])).toEqual([
      ["claude-opus-5-20260101", "proven"],
      ["claude-haiku-4-5-20251001", "mismatch"],
      ["unproven", "unproven"],
    ]);
  });

  it("renders a pre-provenance historical row as an absence, never as a model", () => {
    // A run stored before SDD 473/475 has no verdict and no effective value; ProbeStore reports it
    // `unproven` when a model was requested, `not-requested` otherwise.
    const [withRequest] = buildProbeView([record({ modelProof: "unproven", requestedModel: "claude-opus-5" })], 0).rows;
    expect(withRequest.model).toBe("unproven");

    const [without] = buildProbeView([record({ modelProof: "not-requested" })], 0).rows;
    expect(without.model).toBe("—");
  });
});
