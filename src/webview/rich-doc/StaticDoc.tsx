import type { ComponentChildren } from "preact";
import type { TiptapJSON } from "../../richDoc/types.js";

/**
 * t-321e9d — a read-only renderer for a (already `toEditorDoc`-resolved) Tiptap doc, for `preact-static`
 * views that never mount the live Tiptap editor (Pin Preview). Covers exactly the node/mark set the real
 * editor can produce (see rich-doc/tiptap.ts's extension list) — anything unrecognized falls through to its
 * children so an unknown wrapper node never silently drops content.
 */
export function StaticDoc({ doc }: { doc: TiptapJSON }) {
  const blocks = renderChildren(doc);
  return blocks.length ? <>{blocks}</> : <p class="empty">No body.</p>;
}

function renderChildren(node: TiptapJSON): ComponentChildren[] {
  return (node.content ?? []).map((child, i) => renderBlock(child, i));
}

function renderBlock(node: TiptapJSON, key: number): ComponentChildren {
  switch (node.type) {
    case "paragraph":
      return <p key={key}>{renderInline(node)}</p>;
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      const Tag = (`h${Math.min(Math.max(level, 1), 3)}`) as "h1" | "h2" | "h3";
      return <Tag key={key}>{renderInline(node)}</Tag>;
    }
    case "blockquote":
      return <blockquote key={key}>{renderChildren(node)}</blockquote>;
    case "codeBlock":
      return <pre key={key}><code>{renderInline(node)}</code></pre>;
    case "bulletList":
      return <ul key={key}>{(node.content ?? []).map((li, i) => renderListItem(li, i))}</ul>;
    case "orderedList":
      return <ol key={key}>{(node.content ?? []).map((li, i) => renderListItem(li, i))}</ol>;
    case "taskList":
      return <ul key={key} data-type="taskList">{(node.content ?? []).map((li, i) => renderListItem(li, i))}</ul>;
    case "horizontalRule":
      return <hr key={key} />;
    case "image": {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : undefined;
      return src ? <img key={key} src={src} alt="" /> : <div key={key} class="rd-missing" />;
    }
    case "tachyonSketch": {
      const src = typeof node.attrs?.previewSrc === "string" ? node.attrs.previewSrc : undefined;
      return (
        <figure key={key} class="tachyon-sketch-node">
          {src ? <img src={src} alt="Pin sketch preview" /> : <div class="tachyon-sketch-missing">Sketch preview unavailable</div>}
        </figure>
      );
    }
    default:
      return <div key={key}>{renderChildren(node)}</div>;
  }
}

function renderListItem(node: TiptapJSON, key: number): ComponentChildren {
  if (node.type === "taskItem") {
    const checked = node.attrs?.checked === true;
    return (
      <li key={key} data-type="taskItem">
        <input type="checkbox" checked={checked} disabled />
        <div>{renderChildren(node)}</div>
      </li>
    );
  }
  return <li key={key}>{renderChildren(node)}</li>;
}

function renderInline(node: TiptapJSON): ComponentChildren[] {
  return (node.content ?? []).map((child, i) => renderInlineNode(child, i));
}

function renderInlineNode(node: TiptapJSON, key: number): ComponentChildren {
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type !== "text") return null;
  let el: ComponentChildren = node.text ?? "";
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        el = <strong>{el}</strong>;
        break;
      case "italic":
        el = <em>{el}</em>;
        break;
      case "strike":
        el = <s>{el}</s>;
        break;
      case "code":
        el = <code>{el}</code>;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : undefined;
        el = href ? <a href={href} target="_blank" rel="noreferrer noopener">{el}</a> : el;
        break;
      }
    }
  }
  return <span key={key}>{el}</span>;
}
