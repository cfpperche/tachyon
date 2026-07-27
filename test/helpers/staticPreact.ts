/**
 * SDD 479 phase 1 — render a real webview component to a deterministic HTML string, with no DOM.
 *
 * Why this exists: the equality proof the spec demands ("the default template's output is the card
 * that shipped, not something that looks like it") is only worth anything if BOTH sides are measured
 * the same way, from the real sources. So:
 *
 *  - the component is compiled from `src/` by esbuild with the same `jsx: "automatic"` /
 *    `jsxImportSource: "preact"` options the real build uses (the repo's `.tsx` files carry no pragma;
 *    vitest's default transform would not pick them up) — the pattern `dsButtonIconLabel.test.ts`
 *    established;
 *  - `preact/hooks` is aliased to `preactHooksStub.ts`, because hooks need a rendering component and
 *    this suite has no DOM;
 *  - the returned vnode tree is walked and serialized here, including function-valued props as `[fn]`,
 *    so a lost `onClick` is a diff and not a silent pass.
 *
 * This is a static serializer, not a renderer: no effects, no state transitions, no layout. Everything
 * the card shows is a function of its props, which is exactly the property the template refactor must
 * not break.
 */
import * as esbuild from "esbuild";
import path from "node:path";

const HOOKS_STUB = path.join(__dirname, "preactHooksStub.ts");

/** Compile+bundle a webview module and load it as a self-contained ESM data URI (no DOM needed). */
export async function loadWebviewModule(entryPath: string): Promise<Record<string, unknown>> {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    jsxImportSource: "preact",
    alias: { "preact/hooks": HOOKS_STUB },
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return (await import(`data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`)) as Record<
    string,
    unknown
  >;
}

/** HTML elements that never carry children — serialized self-closing so the output is re-parseable. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

/** Props that describe the vnode rather than the DOM it produces. */
const NON_DOM_PROPS = new Set(["children", "key", "ref"]);

interface VNodeLike {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function isVNode(value: unknown): value is VNodeLike {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** `style={{ width: "50%" }}` → `width: 50%`. camelCase → kebab-case, numbers left verbatim. */
function serializeStyle(style: Record<string, unknown>): string {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${String(v)}`)
    .join("; ");
}

/**
 * Attributes are emitted in NAME order, not authoring order: HTML attaches no meaning to attribute
 * order, so comparing it would report a diff where the card did not change. Everything that does carry
 * meaning — which attributes exist, their values, and the order of ELEMENTS — is still compared.
 */
function serializeProps(props: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [name, value] of Object.entries(props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (NON_DOM_PROPS.has(name)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "function") {
      // Recorded, not skipped: an action that lost its handler must fail the equality proof.
      out.push(`${name}="[fn]"`);
      continue;
    }
    if (typeof value === "boolean") {
      // aria-*/data-* carry the literal word (preact does the same); other boolean props are bare.
      if (name.startsWith("aria-") || name.startsWith("data-")) out.push(`${name}="${value}"`);
      else if (value) out.push(name);
      continue;
    }
    if (name === "style" && typeof value === "object") {
      out.push(`style="${escapeAttr(serializeStyle(value as Record<string, unknown>))}"`);
      continue;
    }
    out.push(`${name}="${escapeAttr(String(value))}"`);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

/**
 * Serialize a vnode tree to HTML. Function components are INVOKED (that is what makes this a proof
 * about rendered output rather than about vnode shape); `Fragment` needs no special case because
 * preact implements it as a component returning its own children.
 */
export function renderStatic(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return escapeText(node);
  if (typeof node === "number" || typeof node === "bigint") return escapeText(String(node));
  if (Array.isArray(node)) return node.map(renderStatic).join("");
  if (!isVNode(node)) throw new Error(`renderStatic: unsupported node ${Object.prototype.toString.call(node)}`);

  const { type, props } = node;
  if (typeof type === "function") {
    const component = type as { prototype?: { render?: unknown } };
    if (component.prototype && typeof component.prototype.render === "function") {
      throw new Error("renderStatic: class components are not supported (none exist in the sidebar)");
    }
    return renderStatic((type as (p: unknown) => unknown)(props));
  }
  if (typeof type !== "string") throw new Error(`renderStatic: unsupported vnode type ${String(type)}`);

  const attrs = serializeProps(props);
  if (VOID_ELEMENTS.has(type)) return `<${type}${attrs} />`;
  return `<${type}${attrs}>${renderStatic(props.children)}</${type}>`;
}
