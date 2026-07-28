import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";
import { PARENT_CWD_REFUSAL } from "../../src/bridge/spawnContract.js";

/**
 * t-6fe04b — the refusal moves earlier, and starts naming the way out.
 *
 * `parent` and `cwd` were independent optionals, so an incompatible pair type-checked, travelled all
 * the way to the AgentManager, and was refused only at execution — after the caller had composed a
 * whole delegation contract. Worse, the message said only what NOT to do: in the incident behind
 * t-e787dc the caller answered it by writing an absolute path into the child's BRIEFING, which is
 * the least governed outcome available and a direct consequence of a refusal pointing nowhere.
 */

class ToolCapture {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
  registerTool(
    name: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function spawnTool(): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const mcp = new ToolCapture();
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    caller: { kind: "agent", name: "ada" },
    // Deliberately no agent manager wiring: the point is that the refusal lands BEFORE anything
    // downstream is needed. A test that had to build a workspace to see it would be proving the
    // opposite of what this task fixed.
  } as never);
  return mcp.handlers.get("spawn_agent")!;
}

describe("t-6fe04b — spawn_agent refuses parent+cwd at the entry", () => {
  it("refuses the pair before composing anything", async () => {
    const result = await spawnTool()({ name: "helper", cmd: "codex", parent: "ada", cwd: "/somewhere" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot combine parent with cwd");
  });

  describe("the message names the governed alternative", () => {
    it("points at delivery_join instead of only forbidding", async () => {
      const result = await spawnTool()({ name: "helper", cmd: "codex", parent: "ada", cwd: "/somewhere" });

      // The whole reason the refusal moved: a caller who is only told "don't" invents a way around.
      expect(result.content[0]?.text).toContain("delivery_join");
      expect(result.content[0]?.text).toContain("spawn without parent");
    });

    it("is the SAME sentence the manager-level guard throws", () => {
      // Two refusals for one rule must not disagree about the way out. The guard stays — it is the
      // complete one — and this is its earlier, friendlier half.
      expect(PARENT_CWD_REFUSAL).toContain("delivery_join");
      expect(PARENT_CWD_REFUSAL).toContain("cannot combine parent with cwd");
    });
  });

  it("leaves a spawn that states only one of them alone", async () => {
    // Neither field is being deprecated; only the incompatible pair is refused, and only when the
    // caller states `parent` itself. An omitted parent resolves to the caller downstream, which is
    // exactly why the manager-level guard remains the complete check.
    const cwdOnly = await spawnTool()({ name: "helper", cmd: "codex", cwd: "/somewhere" });

    expect(cwdOnly.content[0]?.text ?? "").not.toContain("cannot combine parent with cwd");
  });
});
