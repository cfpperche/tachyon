import { describe, it, expect } from "vitest";
import { buildActivityView } from "../../src/activity/activityView.js";
import { normalizeClaude } from "@tachyon/engine/activity/claudeNormalizer.js";
import vms from "../../scripts/webview-preview/fixtures/activity.vms.json";

// spec 278 — the host-shape / fixture-fidelity guard for the Activity preview view. The browser harness
// imports the CAPTURED VM snapshot (activity.vms.json) because the builder pipeline is node-only. This NODE
// test rebuilds those VMs from the same transcript via the REAL pipeline (normalizeClaude → buildActivityView)
// and asserts equality — so a builder-shape drift makes the captured fixture stale and fails CI, instead of
// letting visual-qa judge a fiction. If this fails after an intentional builder change, regenerate the snapshot.

const base = { sessionId: "s1", cwd: "/repo", timestamp: "2026-06-20T00:00:00Z", version: "2.1.183" };
const line = (o: unknown): string => JSON.stringify(o);

const transcript = [
  line({ ...base, type: "user", message: { role: "user", content: "Refactor the auth guard and run the tests." } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "text", text: "On it — I'll extract the guard, then run the suite." }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "thinking", thinking: "The guard is duplicated across two routes; pull it into a helper." }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/auth/guard.ts" } }] } }),
  line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/repo/src/auth/guard.ts" } }] } }),
  line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 1200, output_tokens: 340 } } }),
  line({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "Test Files 117 passed\nTests 1693 passed" }] } }),
  line({ ...base, type: "assistant", message: { content: [{ type: "text", text: "Done — guard extracted, full suite green (1693 passed)." }] } }),
];

describe("activity preview fixture fidelity", () => {
  it("default matches the real normalize→build pipeline (vendor-free session)", () => {
    expect(vms.default).toEqual(buildActivityView(normalizeClaude(transcript, "/repo/.sess/s1.jsonl")));
  });

  it("the fixture is vendor-free (no image/mermaid/math items → no on-demand bundle needed)", () => {
    const kinds = new Set(vms.default.items.map((i) => i.kind));
    expect(kinds.has("image")).toBe(false);
    for (const it of vms.default.items) expect(JSON.stringify(it)).not.toMatch(/```mermaid|\\\(|\\\[/);
  });

  it("empty matches the real builder degraded/cold state", () => {
    expect(vms.empty).toEqual(buildActivityView([], { tier: "raw-only", degradedFreshness: true }));
  });
});
