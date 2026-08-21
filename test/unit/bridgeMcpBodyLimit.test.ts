import { describe, it, expect } from "vitest";
import { Bridge } from "@tachyon/bridge/Bridge.js";
import { HTTP_BODY_LIMIT_LARGE_BYTES } from "@tachyon/engine/utils/readBody.js";

/** t-75f094 — the /mcp door shares its body ceiling with the Companion doors through
 *  utils/readBody.ts. Two proofs, both through the real HTTP door production uses:
 *  a body above the ceiling is refused, and the largest legitimate body we measured
 *  (a tools/call carrying the declared 512KB maximum of prototype HTML) passes.
 *  The refusal assertions live OUTSIDE the fetch catch on purpose — an assertion
 *  failure inside that catch would read as a torn-down socket and pass vacuously
 *  (measured: this exact shape let the unbounded door pass the oversized test). */
describe("bridge /mcp body limit", () => {
  async function startBridge(): Promise<Bridge> {
    const deps = {
      workspaceRoot: "/tmp",
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      tasks: undefined as never,
      validations: undefined as never,
      notify: () => {},
    };
    const bridge = new Bridge(deps);
    await bridge.start();
    return bridge;
  }

  function post(bridge: Bridge, body: string, sessionId?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body,
    });
  }

  it("refuses an /mcp body above the shared ceiling instead of accumulating it", async () => {
    const bridge = await startBridge();
    try {
      const oversized = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "unknown_tool", arguments: { pad: "a".repeat(HTTP_BODY_LIMIT_LARGE_BYTES + 1024) } },
      });
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(HTTP_BODY_LIMIT_LARGE_BYTES);

      let res: Response | undefined;
      let connError: unknown;
      try {
        res = await post(bridge, oversized);
      } catch (err) {
        // The reader destroys the socket mid-upload once the ceiling is crossed —
        // the caller sees the connection torn down rather than the heap filled.
        connError = err;
      }
      if (res) {
        // A response landed: it must be the refusal naming the ceiling, not a parsed request.
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("body too large");
      } else {
        expect(connError).toBeDefined();
      }
    } finally {
      await bridge.dispose();
    }
  });

  it("passes the largest legitimate body measured: a tools/call at the 512KB declared field maximum", async () => {
    const bridge = await startBridge();
    try {
      const init = await post(
        bridge,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "body-limit-proof", version: "1.0" } },
        }),
      );
      expect(init.status).toBe(200);
      const sessionId = init.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      // Realistic prototype HTML at exactly the declared maximum
      // (packages/bridge/src/tools/tasks.ts:66 — html: z.string().max(512 * 1024)).
      const unit = '<div class="row">\n  <span>ok</span>\n</div>\n';
      const html = unit.repeat(Math.ceil((512 * 1024) / unit.length)).slice(0, 512 * 1024);
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "unknown_tool", arguments: { html } },
      });
      expect(Buffer.byteLength(callBody)).toBeGreaterThan(512 * 1024);

      const res = await post(bridge, callBody, sessionId ?? undefined);
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { jsonrpc?: string; id?: unknown };
      // Unknown-tool handling inside the session is the MCP layer's business; what this
      // asserts is that the DOOR handed the full max-size body to the transport.
      expect(payload.jsonrpc).toBe("2.0");
      expect(payload.id).toBe(2);
    } finally {
      await bridge.dispose();
    }
  });
});
