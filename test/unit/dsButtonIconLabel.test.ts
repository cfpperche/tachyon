import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";

// t-240a3b — 0.56.72 Control regression: the icon-only CSS rule
// `.ds-btn:not(:has(> :not(.codicon))):has(> .codicon)` (design-system.css) only ever sees ELEMENT
// children through `:has(>)`. Button.tsx used to render a text-node label as a bare child, so
// `<Button icon="x">label</Button>` had exactly one element child (.codicon) and wrongly matched the
// icon-only rule, collapsing every icon+label button to 28px. The fix wraps a real label in an element
// (`<span class="ds-btn-label">`); this test proves the DOM shape the CSS selector actually depends on,
// not the implementation that produces it.
//
// Button/IconButton are `forwardRef`-wrapped (preact/compat): the exported binding is directly callable
// as `Component(props)` and returns the rendered vnode tree with no DOM needed (see
// node_modules/preact/compat/src/forwardRef.js — `Forwarded(props)` calls the wrapped render fn inline).
// vitest's default esbuild transform for `.tsx` doesn't pick up this project's preact JSX pragma
// (tsconfig.webview.json / esbuild.mjs set it only for the real build), so each component under test is
// compiled here with the same `jsx: "automatic", jsxImportSource: "preact"` options the real build uses,
// then loaded as a self-contained ESM data-URI module — the real source, not a reimplementation of it.

async function loadComponent(entry: string, exportName: string): Promise<(props: unknown) => unknown> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`)) as Record<
    string,
    (props: unknown) => unknown
  >;
  const component = mod[exportName];
  if (!component) throw new Error(`${entry} does not export ${exportName}`);
  return component;
}

interface HostVNode {
  type: string;
  props: Record<string, unknown> & { children?: unknown; class?: string };
}

function isHostVNode(node: unknown): node is HostVNode {
  return typeof node === "object" && node !== null && typeof (node as { type?: unknown }).type === "string";
}

function isComponentVNode(node: unknown): node is { type: (props: unknown) => unknown; props: unknown } {
  return typeof node === "object" && node !== null && typeof (node as { type?: unknown }).type === "function";
}

/** resolve a rendered child (or array of children) down to the HOST element vnodes a real DOM diff would
 *  mount — recursing through function components (e.g. Icon) exactly like preact's own reconciler does,
 *  without needing an actual DOM. Text/number/null/false children are dropped: `:has(>)` never sees them. */
function elementChildren(node: unknown): HostVNode[] {
  if (node == null || node === false || node === true) return [];
  if (Array.isArray(node)) return node.flatMap(elementChildren);
  if (isComponentVNode(node)) return elementChildren(node.type(node.props));
  if (isHostVNode(node)) return [node];
  return []; // text/number leaf
}

function classesOf(vnode: HostVNode): string[] {
  return String(vnode.props.class ?? "").split(/\s+/).filter(Boolean);
}

describe("Button icon+label DOM shape (t-240a3b)", () => {
  let Button: (props: unknown) => unknown;
  let IconButton: (props: unknown) => unknown;
  let Icon: (props: unknown) => unknown;

  beforeAll(async () => {
    Button = await loadComponent("src/webview/shared/ui/Button.tsx", "Button");
    IconButton = await loadComponent("src/webview/shared/ui/IconButton.tsx", "IconButton");
    Icon = await loadComponent("src/webview/shared/ui/Icon.tsx", "Icon");
  }, 30_000);

  it("an icon+label Button exposes at least one non-.codicon element child", () => {
    const vnode = Button({ icon: "refresh", children: "Refresh" }) as HostVNode;
    expect(vnode.type).toBe("button");
    const children = elementChildren(vnode.props.children);
    expect(children.length).toBeGreaterThanOrEqual(2);
    const nonCodicon = children.filter((c) => !classesOf(c).includes("codicon"));
    expect(nonCodicon.length).toBeGreaterThan(0);
    // the icon itself must still be present and still a codicon — the fix must not drop it.
    expect(children.some((c) => classesOf(c).includes("codicon"))).toBe(true);
  });

  it("an icon+label Button label survives array/JSX-fragment-style children too", () => {
    const vnode = Button({ icon: "copy", children: ["Copy ", "diagnostics"] }) as HostVNode;
    const children = elementChildren(vnode.props.children);
    const nonCodicon = children.filter((c) => !classesOf(c).includes("codicon"));
    expect(nonCodicon.length).toBeGreaterThan(0);
  });

  it("an icon-only Button (no children) still exposes only .codicon element children", () => {
    const vnode = Button({ icon: "refresh" }) as HostVNode;
    const children = elementChildren(vnode.props.children);
    expect(children.length).toBeGreaterThan(0);
    for (const c of children) expect(classesOf(c)).toContain("codicon");
  });

  it("an icon-only Button with a falsy/empty label still exposes only .codicon element children", () => {
    for (const children of [null, undefined, false, ""]) {
      const vnode = Button({ icon: "refresh", children }) as HostVNode;
      const kids = elementChildren(vnode.props.children);
      expect(kids.length).toBeGreaterThan(0);
      for (const c of kids) expect(classesOf(c)).toContain("codicon");
    }
  });

  it("IconButton (the genuine icon-only component) still exposes only .codicon element children", () => {
    const vnode = IconButton({ name: "close", title: "Close" }) as HostVNode;
    expect(vnode.type).toBe("button");
    const children = elementChildren(vnode.props.children);
    expect(children.length).toBeGreaterThan(0);
    for (const c of children) expect(classesOf(c)).toContain("codicon");
  });

  it("a trailing literal <Icon/> (sidebar/App.tsx tag-clear pattern) stays a direct sibling, not nested in the label span", () => {
    // mirrors src/webview/sidebar/App.tsx:1023 — <Button class="tag-clear">#{activePinTag}<Icon name="close" /></Button>
    const vnode = Button({ class: "tag-clear", children: ["#", "sometag", { type: Icon, props: { name: "close" } }] }) as HostVNode;
    const children = elementChildren(vnode.props.children);
    // exactly one label span (the two text nodes glued into ONE run — no gap between "#" and the tag) and
    // the resolved codicon as a direct sibling, so the .ds-btn 6px icon<->text gap still applies between them.
    expect(children.length).toBe(2);
    const codicon = children.find((c) => classesOf(c).includes("codicon"));
    const label = children.find((c) => !classesOf(c).includes("codicon"));
    expect(codicon).toBeTruthy();
    expect(label).toBeTruthy();
    expect(classesOf(label!)).toContain("ds-btn-label");
    expect((label!.props.children as unknown[]).join("")).toBe("#sometag");
  });

  it("a leading literal <Icon/> followed by its own <span> label (mission-control/App.tsx more-item pattern) leaves both as direct siblings", () => {
    // mirrors src/webview/mission-control/App.tsx:680 — <Button><Icon name={a.icon} /><span>{a.label}</span></Button>
    const vnode = Button({
      class: "more-item",
      children: [{ type: Icon, props: { name: "check" } }, { type: "span", props: { children: "Do the thing" } }],
    }) as HostVNode;
    const children = elementChildren(vnode.props.children);
    // no ds-btn-label wrap here: the caller's own <span> is a direct element child, not a contiguous
    // text/number run, so it isn't glued into a new label span — it stays a sibling of the codicon.
    expect(children.length).toBe(2);
    expect(classesOf(children[0])).toContain("codicon");
    expect(classesOf(children[1])).not.toContain("ds-btn-label");
    expect(children[1].props.children).toBe("Do the thing");
  });

  it("the design-system.css icon-only rule still exists (guards against deleting instead of fixing)", () => {
    const css = readFileSync("src/webview/shared/design-system.css", "utf8");
    expect(css).toContain(".ds-btn:not(:has(> :not(.codicon))):has(> .codicon)");
  });

  // Extra proof when the environment happens to provide a real `:has()`-capable DOM (this repo's default
  // vitest environment is "node", with no jsdom/happy-dom dependency, so this block is expected to be
  // skipped here — kept for a future/alternate environment where it can bite harder than the vnode check.
  it("optionally cross-checks against the real CSS selector when a `:has`-capable DOM is available", async () => {
    let hasDom = typeof document !== "undefined" && typeof Element !== "undefined" && "matches" in Element.prototype;
    if (hasDom) {
      try {
        document.createElement("div").matches(":has(> span)");
      } catch {
        hasDom = false;
      }
    }
    if (!hasDom) {
      expect(hasDom).toBe(false); // documents the skip instead of silently no-op-ing.
      return;
    }
    const selector = ".ds-btn:not(:has(> :not(.codicon))):has(> .codicon)";
    const labeled = document.createElement("button");
    labeled.className = "ds-btn";
    labeled.innerHTML = '<span class="codicon"></span><span class="ds-btn-label">Refresh</span>';
    document.body.appendChild(labeled);
    expect(labeled.matches(selector)).toBe(false);

    const iconOnly = document.createElement("button");
    iconOnly.className = "ds-btn";
    iconOnly.innerHTML = '<span class="codicon"></span>';
    document.body.appendChild(iconOnly);
    expect(iconOnly.matches(selector)).toBe(true);
  });
});
