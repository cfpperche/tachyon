import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BridgeDeps, fail, ok } from "./shared.js";

export function registerConfigurationTools(mcp: McpServer, deps: BridgeDeps): void {

  // t-099be8 — mechanical gate for agent self-edits of tachyon.yml (do NOT use raw Write for this file).
  mcp.registerTool(
    "write_tachyon_config",
    {
      description:
        "Validate and write the workspace tachyon.yml in one step. Runs the same loadConfig/schema/cross-ref checks " +
        "the extension uses and REFUSES to save on hard errors (invalid YAML, schema, cycles, multi-owner, etc.). " +
        "Dangling subagents names become warnings and are dropped rather than wiping the roster. " +
        "Prefer this over raw filesystem Write when editing tachyon.yml so a bad edit cannot detonate only on next reload.",
      inputSchema: {
        content: z.string().min(1).describe("Full tachyon.yml text to validate and persist"),
      },
    },
    async ({ content }) => {
      try {
        if (!deps.writeTachyonConfig) return fail(new Error("write_tachyon_config is not available on this Bridge"));
        const result = deps.writeTachyonConfig(content);
        if (!result.ok) {
          return fail(
            new Error(
              `tachyon.yml rejected (not saved):\n${result.errors.join("\n")}${
                result.warnings.length ? `\nwarnings:\n${result.warnings.join("\n")}` : ""
              }`,
            ),
          );
        }
        return ok(
          JSON.stringify(
            {
              ok: true,
              saved: true,
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
