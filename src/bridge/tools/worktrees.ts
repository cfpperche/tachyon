import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, resolveDeclaredActor } from "./shared.js";
import type { BridgeDeps } from "./shared.js";

export function registerWorktreeTools(mcp: McpServer, deps: BridgeDeps): void {

  // ── spec 392 — managed worktree registry ──────────────────────────────────
  mcp.registerTool(
    "create_worktree",
    {
      description:
        "Create a Tachyon-managed git worktree under the canonical worktree base (spec 392). " +
        "kind=change creates an implementation/task checkout at <base>/<wsHash>/change/<slug>. " +
        "Registers the entry so VS Code multi-root reveal can include it. Does not spawn an agent.",
      inputSchema: {
        kind: z.enum(["change"]).describe("v1: only change worktrees via this tool (agent worktrees use spawn with worktree:true)"),
        slug: z.string().min(1).max(64).describe("path/branch slug (alphanumeric, ._- )"),
        branch: z.string().min(1).optional().describe("branch name; default tachyon/change/<slug>"),
        baseRef: z.string().min(1).optional().describe("git ref to branch from; default HEAD"),
        taskId: z.string().regex(/^t-[0-9a-f]{6}$/).optional(),
      },
    },
    async ({ kind, slug, branch, baseRef, taskId }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        if (kind !== "change") return fail(new Error("create_worktree v1 only supports kind=change"));
        const actor = resolveDeclaredActor(deps, undefined);
        if (!actor.ok) return fail(new Error(actor.message));
        const entry = await deps.managedWorktrees.createChange({
          slug,
          branch,
          baseRef,
          taskId,
          createdBy: actor.name,
        });
        return ok(JSON.stringify(entry, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_worktrees",
    {
      description: "List Tachyon-managed worktree registry entries (agent + change). Does not invent paths.",
      inputSchema: {
        kind: z.enum(["agent", "change"]).optional(),
        status: z.enum(["active", "abandoned"]).optional(),
      },
    },
    async ({ kind, status }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        return ok(JSON.stringify(deps.managedWorktrees.list({ kind, status }), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "worktree_hygiene",
    {
      description:
        "spec 444 — list Tachyon-managed worktree registry entries WITH a fail-closed hygiene " +
        "classification per entry: record-only (path gone), ready-to-remove (clean, unoccupied, " +
        "no unique commits vs its recorded base), needs-review (dirty and/or unique commits, with " +
        "a stated reason), or occupied (a live agent holds it). Read-only — never mutates the " +
        "registry or any checkout. Slower than list_worktrees (probes git per entry); prefer " +
        "list_worktrees for identity-only reads on a hot path.",
      inputSchema: {
        kind: z.enum(["agent", "change"]).optional(),
        status: z.enum(["active", "abandoned"]).optional(),
      },
    },
    async ({ kind, status }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        return ok(JSON.stringify(await deps.managedWorktrees.listClassified({ kind, status }), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_worktree",
    {
      description: "Get one managed worktree by id or absolute path.",
      inputSchema: { idOrPath: z.string().min(1) },
    },
    async ({ idOrPath }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        const entry = deps.managedWorktrees.get(idOrPath);
        if (!entry) return fail(new Error(`managed worktree not found: ${idOrPath}`));
        return ok(JSON.stringify(entry, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "register_worktree",
    {
      description:
        "Register an existing checkout that is already a git worktree of this repository under " +
        "<worktree.base>/<wsHash>/… . Validates realpath, common-dir, and live branch. Does not run git worktree add.",
      inputSchema: {
        kind: z.enum(["agent", "change"]),
        path: z.string().min(1),
        branch: z.string().min(1).optional().describe("optional; when set must match the live branch"),
        baseRef: z.string().min(1).optional(),
        tachyonCreatedBranch: z.boolean().optional(),
        agent: z.string().optional().describe("required when kind=agent"),
        taskId: z.string().regex(/^t-[0-9a-f]{6}$/).optional(),
        slug: z.string().min(1).max(64).optional().describe("required when kind=change"),
      },
    },
    async (a) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        const actor = resolveDeclaredActor(deps, undefined);
        if (!actor.ok) return fail(new Error(actor.message));
        if (a.kind === "agent" && !a.agent) return fail(new Error("register_worktree kind=agent requires agent"));
        if (a.kind === "change" && !a.slug) return fail(new Error("register_worktree kind=change requires slug"));
        const principal = deps.caller ?? { kind: "legacy" as const };
        const entry = await deps.managedWorktrees.register({
          kind: a.kind,
          path: a.path,
          branch: a.branch,
          baseRef: a.baseRef,
          // Never trust client-supplied ownership of branch creation; only Tachyon-internal sync may set true.
          tachyonCreatedBranch: false,
          agent: a.agent,
          taskId: a.taskId,
          slug: a.slug,
          createdBy: actor.name,
          actor: { kind: principal.kind, name: actor.name },
        });
        return ok(JSON.stringify(entry, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "unregister_worktree",
    {
      description:
        "Drop a registry entry without deleting the git worktree on disk. " +
        "Caller must be the entry creator/agent owner, or a human host principal (shared legacy/external tokens are not privileged).",
      inputSchema: { idOrPath: z.string().min(1) },
    },
    async ({ idOrPath }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        const actor = resolveDeclaredActor(deps, undefined);
        if (!actor.ok) return fail(new Error(actor.message));
        const principal = deps.caller ?? { kind: "legacy" as const };
        const okRm = deps.managedWorktrees.unregister(idOrPath, {
          kind: principal.kind,
          name: actor.name,
        });
        if (!okRm) return fail(new Error(`managed worktree not found: ${idOrPath}`));
        return ok(JSON.stringify({ unregistered: true, idOrPath }, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "remove_worktree",
    {
      description:
        "Remove a managed git worktree via the WorktreeManager engine (occupancy fail-closed). " +
        "Caller must own the entry (creator/agent) or be privileged. " +
        "t-621613 — one exception, for residue nothing else can reach: an AGENT entry whose agent is " +
        "provably gone (not declared, not live, not in the session ledger) may be removed by any " +
        "agent caller, because there is no inhabitant left to protect. It is still classification-gated, " +
        "so a home that is dirty, occupied or holding unlanded commits is refused like any other. " +
        "Dirty trees require confirmDirty=true. Optional deleteBranch only when Tachyon created the branch.",
      inputSchema: {
        idOrPath: z.string().min(1),
        deleteBranch: z.boolean().optional().default(false),
        confirmDirty: z.boolean().optional().default(false).describe("required when the worktree has uncommitted changes"),
      },
    },
    async ({ idOrPath, deleteBranch, confirmDirty }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        const actor = resolveDeclaredActor(deps, undefined);
        if (!actor.ok) return fail(new Error(actor.message));
        const principal = deps.caller ?? { kind: "legacy" as const };
        const callerActor = { kind: principal.kind, name: actor.name };
        const result = await deps.managedWorktrees.remove(idOrPath, {
          deleteBranch,
          confirmDirty,
          actor: callerActor,
        });
        if (result.removed) return ok(JSON.stringify(result, null, 2));
        // t-e74631 — the owner-only rule above can force past dirtiness, which is why it stays
        // owner-only. A delegating parent refused there is not out of options: retry through the
        // classification-gated path, which grants lineage authority precisely BECAUSE it proves
        // clean/unoccupied/contained at execution time and cannot force anything. Only the
        // authority verdict is retried — a worktree refused for dirtiness is refused again, by the
        // same classifier, with the same reason.
        if (!confirmDirty) {
          const viaHygiene = await deps.managedWorktrees.removeClassified(idOrPath, { deleteBranch, actor: callerActor });
          if (viaHygiene.removed) return ok(JSON.stringify(viaHygiene, null, 2));
          return fail(new Error(viaHygiene.error ?? result.error ?? "remove refused"));
        }
        return fail(new Error(result.error ?? "remove refused"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "reconcile_worktree_hygiene",
    {
      description:
        "t-e74631 — sweep CHANGE worktrees and remove the ones that are provably safe, without " +
        "waiting for the agent that created each to wake up. Authority is hierarchical: the owner, " +
        "its registered lineage ancestors, and the host human may all ask. Authority never bypasses " +
        "the material locks — every removal still re-proves clean, unoccupied, and contained in base " +
        "or trunk at execution time, and only a Tachyon-created branch is deleted. Agent worktrees " +
        "are never swept: an agent's working home is not residue. Refusals are always reported with " +
        "a reason rather than skipped silently. Use dry_run first to see what would go.",
      inputSchema: {
        dry_run: z.boolean().optional().default(false).describe("report what would be removed, touching nothing"),
        delete_branch: z.boolean().optional().default(true).describe("also delete the branch when Tachyon created it"),
      },
    },
    async ({ dry_run, delete_branch }) => {
      try {
        if (!deps.managedWorktrees) return fail(new Error("managed worktrees are not available on this Bridge"));
        const actor = resolveDeclaredActor(deps, undefined);
        if (!actor.ok) return fail(new Error(actor.message));
        const principal = deps.caller ?? { kind: "legacy" as const };
        const report = await deps.managedWorktrees.reconcileHygiene({
          actor: { kind: principal.kind, name: actor.name },
          deleteBranch: delete_branch,
          dryRun: dry_run,
        });
        return ok(JSON.stringify(report, null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
