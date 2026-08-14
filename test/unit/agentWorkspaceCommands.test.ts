import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SETUP_PATH,
  WORKSPACE_SETUP_REFERENCE_ID,
  parseWorkspaceCommandLines,
  studioOwnsWorkspaceCommands,
  studioWorkspaceCommandIds,
} from "@tachyon/shared/config/agentWorkspaceCommands.js";
import { mergedWorkspaceCommandReferences, workspaceCommandWriteFor } from "@tachyon/engine/config/agentWorkspaceCommandWrite.js";
import type { AgentProfileStudioEditableV1 } from "@tachyon/shared/config/agentProfileStudio.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const digest = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const editable = (setup: string[] = []): Pick<AgentProfileStudioEditableV1, "worktree"> => ({
  worktree: { enabled: true, branch: "", setup },
});

describe("workspace setup profile references", () => {
  it("writes one pinned setup artifact with one command per line", () => {
    const write = workspaceCommandWriteFor(editable(["python -m venv .venv", "  pip install -e .  ", "   "]));
    const text = "python -m venv .venv\npip install -e .\n";
    expect(write.artifacts).toEqual([{ path: WORKSPACE_SETUP_PATH, text, sha256: digest(text) }]);
    expect(write.localReferences).toEqual([expect.objectContaining({
      id: WORKSPACE_SETUP_REFERENCE_ID,
      kind: "worktree-setup",
      path: WORKSPACE_SETUP_PATH,
      mode: "pinned",
      sha256: digest(text),
    })]);
  });

  it("writes nothing when setup is cleared", () => {
    expect(workspaceCommandWriteFor(editable())).toEqual({ artifacts: [], localReferences: [] });
  });

  it("rebuilds its owned reference while preserving unrelated references", () => {
    const current = {
      schemaVersion: 1 as const,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      references: [
        { id: "instructions", kind: "instructions" as const, scope: "profile" as const, owner: AGENT_ID, path: "instructions.md", mode: "pinned" as const, sha256: "b".repeat(64) },
        { id: WORKSPACE_SETUP_REFERENCE_ID, kind: "worktree-setup" as const, scope: "profile" as const, owner: AGENT_ID, path: WORKSPACE_SETUP_PATH, mode: "pinned" as const, sha256: "c".repeat(64) },
      ],
    };
    const rewritten = mergedWorkspaceCommandReferences(current, workspaceCommandWriteFor(editable(["npm ci"])));
    expect(rewritten.map((reference) => reference.id)).toEqual(["instructions", WORKSPACE_SETUP_REFERENCE_ID]);
    expect(rewritten.find((reference) => reference.id === WORKSPACE_SETUP_REFERENCE_ID)?.sha256).toBe(digest("npm ci\n"));
  });

  it("preserves a foreign setup id and does not publish replacement bytes", () => {
    expect(studioOwnsWorkspaceCommands({ setup: ["workspace-published-setup"] })).toEqual({ setup: false });
    expect(studioWorkspaceCommandIds({ setup: [], current: { setup: ["workspace-published-setup"] } }))
      .toEqual({ setup: ["workspace-published-setup"] });
    expect(workspaceCommandWriteFor(editable(["sneaky overwrite"]), { worktree: { setup: ["workspace-published-setup"] } }))
      .toEqual({ artifacts: [], localReferences: [] });
  });

  it("parses nonblank command lines", () => {
    expect(parseWorkspaceCommandLines("npm ci\n\n  npm run build  \n")).toEqual(["npm ci", "npm run build"]);
  });
});
