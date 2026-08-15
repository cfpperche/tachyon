import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeDeps, AGENT_NAME, fail, normalizeCreatePinInput, ok, plainTextDoc, resolveDeclaredActor } from "./shared.js";
import { SIDEBAR_PIN_TEXT_MAX } from "@tachyon/engine/sidebar/wireText.js";

export function registerPinTools(mcp: McpServer, deps: BridgeDeps): void {

  mcp.registerTool(
    "create_pin",
    {
      description:
        "Pin a finding to the project's shared checklist (visible to the human in the sidebar and " +
        "to every agent via list_pins). Use for knowledge worth keeping that is NOT work: constraints " +
        "learned the hard way, decisions other agents must know, gotchas. A bug or any actionable defect " +
        "is WORK — file it with create_task (kind: 'bug') so it enters triage; a pinned bug is invisible " +
        "to the queue. If you know the task id and are writing a task-local scratchpad note, use " +
        "append_task_note instead.",
      inputSchema: {
        title: z.string().min(1).max(200).optional().describe("short sidebar title; prefer this when the finding needs a longer detail body"),
        text: z.string().min(1).max(8000).optional().describe("legacy/full finding text; if long or multiline, Tachyon derives a short title and stores the full text as detail"),
        detail: z.string().min(1).max(8000).optional().describe("optional rich detail body; when set, the sidebar title stays short"),
        tags: z.array(z.string()).max(12).optional().describe("optional classification tags for filtering pins"),
        agent: AGENT_NAME.optional().describe("your agent name (authorship shown in the sidebar) — it's the value of your $TACHYON_AGENT_NAME env var; never guess it"),
      },
    },
    async ({ title, text, detail, tags, agent }) => {
      try {
        const authorActor = resolveDeclaredActor(deps, agent);
        if (!authorActor.ok) return fail(new Error(authorActor.message));
        const author = authorActor.name;
        const input = normalizeCreatePinInput({ title, text, detail });
        const pin = input.detail
          ? await deps.pins.createRich(input.title, author ?? "agent", { doc: plainTextDoc(input.detail), attachments: [], tags })
          : await deps.pins.create(input.title, author ?? "agent", { tags });
        deps.onPinsChanged?.();
        return ok(`pinned as ${pin.id}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "list_pins",
    {
      description: "Read the project's shared checklist — check it before starting work to avoid re-discovering what's already known.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(JSON.stringify(deps.pins.list(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "get_pin",
    {
      description:
        "Read one pin's rich local detail when available. Returns summary + Tiptap JSON + attachment metadata/relative paths; never returns image bytes/base64.",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
      },
    },
    async ({ id }) => {
      try {
        return ok(JSON.stringify(deps.pins.readDetail(id), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "complete_pin",
    {
      description: "Mark a pin done (or reopen it with done=false).",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
        done: z.boolean().default(true),
      },
    },
    async ({ id, done }) => {
      try {
        const pin = await deps.pins.setDone(id, done);
        deps.onPinsChanged?.();
        return ok(`pin ${pin.id} ${done ? "completed" : "reopened"}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  mcp.registerTool(
    "update_pin",
    {
      description: "Edit a pin's text and/or tags. Preserves its id, author, created time, and done state.",
      inputSchema: {
        id: z.string().regex(/^p-[0-9a-f]{6}$/).describe("pin id from list_pins"),
        text: z.string().min(1).max(SIDEBAR_PIN_TEXT_MAX).optional().describe("the new Sidebar title; omit to retag without changing it"),
        tags: z.array(z.string()).max(12).optional().describe("new complete tag list; [] clears all tags"),
      },
    },
    async ({ id, text, tags }) => {
      try {
        if (text === undefined && tags === undefined) throw new Error("update_pin requires text or tags");
        const pin = await deps.pins.update(id, { ...(text !== undefined ? { text } : {}), ...(tags !== undefined ? { tags } : {}) });
        deps.onPinsChanged?.();
        return ok(`pin ${pin.id} updated`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
