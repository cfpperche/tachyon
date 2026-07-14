import { describe, expect, it } from "vitest";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import {
  WorkspaceClientRegistry,
  type ConnectWorkspaceClient,
} from "../../src/shell/WorkspaceClientRegistry.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";

describe("WorkspaceClientRegistry", () => {
  it("converges concurrent attaches and detaches only the client lease", async () => {
    const root = "/workspace/one";
    let connects = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = client(root);
    const registry = new WorkspaceClientRegistry({
      canonicalize: (value) => value,
      connect: async () => {
        connects += 1;
        await gate;
        return fake;
      },
    });

    const first = registry.attach(root);
    const second = registry.attach(root);
    release();
    expect(await first).toBe(fake);
    expect(await second).toBe(fake);
    expect(connects).toBe(1);
    expect(registry.list()).toEqual([fake]);
    await registry.detach(root);
    expect(fake.isClosed).toBe(true);
    expect(registry.list()).toEqual([]);
    await registry.detach(root);
  });

  it("cancels an in-flight attach without retaining or stopping an engine", async () => {
    const root = "/workspace/pending";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = client(root);
    const registry = new WorkspaceClientRegistry({
      canonicalize: (value) => value,
      connect: async () => {
        await gate;
        return fake;
      },
    });
    const attaching = registry.attach(root);
    const detaching = registry.detach(root);
    release();
    await expect(attaching).rejects.toMatchObject({ code: "ATTACH_CANCELLED" });
    await detaching;
    expect(fake.isClosed).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("detaches by the remembered alias after the workspace path disappears", async () => {
    let pathExists = true;
    const fake = client("/canonical/workspace");
    const registry = new WorkspaceClientRegistry({
      canonicalize: () => {
        if (!pathExists) throw new Error("workspace no longer exists");
        return "/canonical/workspace";
      },
      connect: async () => fake,
    });
    await registry.attach("/alias/workspace");
    pathExists = false;
    await registry.detach("/alias/workspace");
    expect(fake.isClosed).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("refuses ambiguous display hashes and rejects new work after registry close", async () => {
    const clients = new Map([
      ["/workspace/a", client("/workspace/a", "collision")],
      ["/workspace/b", client("/workspace/b", "collision")],
    ]);
    const connect: ConnectWorkspaceClient = async (root) => {
      const found = clients.get(root);
      if (!found) throw new Error("missing fixture client");
      return found;
    };
    const registry = new WorkspaceClientRegistry({ canonicalize: (value) => value, connect });
    await Promise.all([...clients.keys()].map((root) => registry.attach(root)));
    expect(() => registry.findByHash("collision")).toThrow(/multiple canonical roots/i);
    await registry.close();
    expect([...clients.values()].every((entry) => entry.isClosed)).toBe(true);
    await expect(registry.attach("/workspace/c")).rejects.toMatchObject({ code: "REGISTRY_CLOSED" });
  });
});

function client(root: string, workspaceHash = `hash-${root.at(-1) ?? "x"}`): FakeWorkspaceClient {
  const identity = projectionIdentity(root, { workspaceHash });
  return new FakeWorkspaceClient({ identity, snapshot: projectionSnapshot(identity) });
}
