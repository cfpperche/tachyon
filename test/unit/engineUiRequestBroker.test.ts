import { afterEach, describe, expect, it } from "vitest";
import { EngineUiRequestBroker, ENGINE_UI_CAPABILITY } from "../../src/engine-service/uiRequestBroker.js";

const brokers: EngineUiRequestBroker[] = [];

afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close();
});

describe("EngineUiRequestBroker", () => {
  it("returns UI_UNAVAILABLE immediately with no capable shell", async () => {
    const broker = createBroker();
    broker.registerShell("read-only-shell", ["vscode.diff"]);
    await expect(broker.request(focus("ui-no-shell-0001"))).rejects.toMatchObject({ code: "UI_UNAVAILABLE" });
  });

  it("allows exactly one capable shell to claim and complete an operation", async () => {
    const broker = createBroker();
    broker.registerShell("shell-one", [ENGINE_UI_CAPABILITY]);
    broker.registerShell("shell-two", [ENGINE_UI_CAPABILITY]);
    const result = broker.request(command("ui-command-0001"));

    expect(broker.claim("shell-one")).toEqual(command("ui-command-0001"));
    expect(broker.claim("shell-two")).toBeNull();
    expect(() => broker.complete("shell-two", ok("ui-command-0001", "wrong")))
      .toThrowError(expect.objectContaining({ code: "UI_CLAIM_MISMATCH" }));
    expect(broker.complete("shell-one", ok("ui-command-0001", { opened: true }))).toBe("ui-command-0001");
    await expect(result).resolves.toEqual({ opened: true });
    expect(() => broker.complete("shell-one", ok("ui-command-0001", null)))
      .toThrowError(expect.objectContaining({ code: "UI_REQUEST_MISSING" }));
  });

  it("never reassigns a claim after the executing shell disconnects", async () => {
    const broker = createBroker();
    broker.registerShell("shell-one", [ENGINE_UI_CAPABILITY]);
    broker.registerShell("shell-two", [ENGINE_UI_CAPABILITY]);
    const result = broker.request(focus("ui-disconnect-0001"));
    const rejected = expect(result).rejects.toMatchObject({ code: "UI_UNAVAILABLE" });
    expect(broker.claim("shell-one")).toEqual(focus("ui-disconnect-0001"));
    broker.unregisterShell("shell-one");
    await rejected;
    expect(broker.claim("shell-two")).toBeNull();
  });

  it("keeps an unclaimed request available to another eligible shell", async () => {
    const broker = createBroker();
    broker.registerShell("shell-one", [ENGINE_UI_CAPABILITY]);
    broker.registerShell("shell-two", [ENGINE_UI_CAPABILITY]);
    const result = broker.request(focus("ui-fallback-0001"));
    broker.unregisterShell("shell-one");
    expect(broker.claim("shell-two")).toEqual(focus("ui-fallback-0001"));
    broker.complete("shell-two", ok("ui-fallback-0001", null));
    await expect(result).resolves.toBeNull();
  });
});

function createBroker(): EngineUiRequestBroker {
  const broker = new EngineUiRequestBroker({ timeoutMs: 1_000 });
  brokers.push(broker);
  return broker;
}

function focus(operationId: string) {
  return { schemaVersion: 1 as const, operationId, kind: "focus-primary" as const };
}

function command(operationId: string) {
  return {
    schemaVersion: 1 as const,
    operationId,
    kind: "execute-command" as const,
    command: "tachyon.doctor",
    args: ["abc12345"],
  };
}

function ok(operationId: string, value: null | string | { opened: boolean }) {
  return { schemaVersion: 1 as const, operationId, status: "ok" as const, value };
}
