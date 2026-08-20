import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { registerTools, type BridgeDeps } from "@tachyon/bridge/tools.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  definitions = new Map<string, { description?: string }>();

  registerTool(
    name: string,
    definition: { description?: string },
    handler: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void {
    this.definitions.set(name, definition);
    this.handlers.set(name, handler);
  }
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-tasks-"));
  roots.push(root);
  const tasks = new TaskStore(root);
  await tasks.create({
    id: "t-a90049",
    title: "Companion sai do Settings e vira app proprio",
    body: "A tela tem 680 linhas e aproximadamente 310 delas sao Companion — 45% do app de Settings.",
    author: "test",
  });
  await tasks.create({
    id: "t-32068b",
    title: "Companion tem dois cabecalhos e um icone",
    body: "O app mostra um cabecalho sem relacao com a navegacao.",
    author: "test",
  });
  await tasks.create({
    id: "t-acce01",
    title: "Retomar sessão interrompida",
    body: "O corpo secreto do cartao nao deve aparecer inteiro na busca ampla. marcador-final-privado",
    author: "test",
  });
  const mcp = new FakeMcp();
  registerTools(mcp as never, { workspaceRoot: root, tasks, notify: () => {} } as unknown as BridgeDeps);
  const handler = mcp.handlers.get("search_tasks");
  if (!handler) throw new Error("search_tasks not registered");
  return { call: handler, description: mcp.definitions.get("search_tasks")?.description ?? "" };
}

function payload(result: ToolResult): Array<Record<string, string>> {
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as Array<Record<string, string>>;
}

describe("t-a5ca77 search_tasks", () => {
  it("finds the Companion app decision first and explains the match with a snippet", async () => {
    const search = await fixture();
    const rows = payload(await search.call({ query: "companion AND app", limit: 10 }));

    expect(rows[0]).toMatchObject({ id: "t-a90049", title: "Companion sai do Settings e vira app proprio" });
    expect(rows[0]!.snippet).toContain("[Companion]");
    expect(rows[0]!.snippet).toContain("[app]");
  });

  it("matches accented text from an unaccented term", async () => {
    const search = await fixture();
    const rows = payload(await search.call({ query: "sessao" }));

    expect(rows.map((row) => row.id)).toContain("t-acce01");
  });

  it("keeps broad results short and documents the accepted query language", async () => {
    const search = await fixture();
    const result = await search.call({ query: "app OR cartao", limit: 50 });
    const rows = payload(result);

    expect(rows.length).toBeGreaterThan(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "snippet", "status", "title"]);
    expect(result.content[0]!.text).not.toContain("marcador-final-privado");
    expect(search.description).toContain("FTS5");
    expect(search.description).toContain("NEAR");
    expect(search.description).toContain("not a natural-language question");
  });
});
