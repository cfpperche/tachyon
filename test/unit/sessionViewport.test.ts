import { describe, expect, it } from "vitest";
import { SessionViewportRegistry } from "../../src/presentation/sessionViewport.js";

/**
 * t-feaaea — the arbiter that keeps ONE exclusive tmux client per session. Measured on tmux 3.6:
 * two clients on one session make tmux pad the larger one with `·` and then `attach -d` evicts it,
 * which is the reported "dotted artifacts, then detached" defect.
 */
describe("SessionViewportRegistry", () => {
  it("releases the previous viewport when another kind claims the session", () => {
    const registry = new SessionViewportRegistry();
    const takers: string[] = [];
    registry.claim("tachyon-ws-claude", "pane", (taker) => takers.push(taker));

    registry.claim("tachyon-ws-claude", "terminal", () => {});

    expect(takers).toEqual(["terminal"]);
    expect(registry.ownerOf("tachyon-ws-claude")).toBe("terminal");
  });

  it("never asks a viewport to release itself when it re-claims", () => {
    const registry = new SessionViewportRegistry();
    let released = 0;
    const release = () => { released += 1; };
    registry.claim("s", "terminal", release);

    // Revealing an already-open terminal, or the pane restarting its own attach after a resize.
    registry.claim("s", "terminal", release);

    expect(released).toBe(0);
    expect(registry.ownerOf("s")).toBe("terminal");
  });

  it("keeps sessions independent", () => {
    const registry = new SessionViewportRegistry();
    const released: string[] = [];
    registry.claim("a", "pane", () => released.push("a"));
    registry.claim("b", "terminal", () => released.push("b"));

    registry.claim("a", "terminal", () => {});

    expect(released).toEqual(["a"]);
    expect(registry.ownerOf("b")).toBe("terminal");
  });

  it("hands ownership to the taker even when the outgoing viewport throws on release", () => {
    const registry = new SessionViewportRegistry();
    registry.claim("s", "pane", () => { throw new Error("webview already gone"); });

    expect(() => registry.claim("s", "terminal", () => {})).not.toThrow();
    expect(registry.ownerOf("s")).toBe("terminal");
  });

  it("cannot be bounced back by a release hook that re-claims re-entrantly", () => {
    const registry = new SessionViewportRegistry();
    registry.claim("s", "pane", () => registry.claim("s", "pane", () => {}));

    registry.claim("s", "terminal", () => {});

    // The taker is the owner: a viewport losing the session must not grab it back inside its own
    // release, or the two doors ping-pong the tmux client between them.
    expect(registry.ownerOf("s")).toBe("terminal");
  });

  it("drops ownership on release, and ignores a release from a viewport that no longer owns it", () => {
    const registry = new SessionViewportRegistry();
    registry.claim("s", "pane", () => {});
    registry.claim("s", "terminal", () => {});

    registry.release("s", "pane"); // late close of the pane that already handed over
    expect(registry.ownerOf("s")).toBe("terminal");

    registry.release("s", "terminal");
    expect(registry.ownerOf("s")).toBeUndefined();
  });
});
