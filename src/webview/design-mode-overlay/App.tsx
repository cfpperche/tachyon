import { useEffect, useRef } from "preact/hooks";

const STYLE_KEYS = ["color", "backgroundColor", "fontSize", "fontWeight", "fontFamily", "display", "padding", "margin", "border", "borderRadius", "width", "height", "position", "flexDirection", "gap", "justifyContent", "alignItems"] as const;

export type DesignModeOverlayOptions = {
  bindingName: string;
  focusColor: string;
  restorePickMode: boolean;
};

type PickElement = HTMLElement & { innerText?: string };

export function App({ bindingName, focusColor, restorePickMode }: DesignModeOverlayOptions) {
  const outline = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let pickMode = restorePickMode;
    let hover: Element | null = null;
    const root = outline.current!;
    const queue = window.__tachyonDmQueue = window.__tachyonDmQueue || [];
    const post = (value: unknown) => {
      const raw = JSON.stringify(value);
      queue.push(raw);
      try {
        const binding = window[bindingName as keyof Window];
        if (typeof binding === "function") (binding as (payload: string) => void)(raw);
      } catch { /* the polling queue is the reliable fallback */ }
    };
    const clear = () => { hover = null; root.style.display = "none"; };
    const show = (el: Element) => {
      const rect = el.getBoundingClientRect();
      hover = el;
      Object.assign(root.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const move = (event: MouseEvent) => {
      if (!pickMode) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      if (el && el !== root && el !== hover) show(el);
    };
    const capture = (el: PickElement) => {
      const rect = el.getBoundingClientRect();
      const computed = getComputedStyle(el);
      const styles: Record<string, string> = {};
      for (const key of STYLE_KEYS) styles[key] = computed[key] || "";
      return {
        url: location.href,
        tag: el.tagName,
        id: el.id || "",
        className: typeof el.className === "string" ? el.className : "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 2_000),
        html: el.outerHTML.slice(0, 12_000),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        styles,
      };
    };
    const click = (event: MouseEvent) => {
      if (!pickMode) return;
      const el = document.elementFromPoint(event.clientX, event.clientY) as PickElement | null;
      if (!el || el === root) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      post(capture(el));
      clear();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { pickMode = false; clear(); } };
    const nav = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("a[href],form")) post({ __layout: "internalNav" });
    };
    window.__tachyonDmSetPickMode = (on: boolean) => { pickMode = !!on; if (!pickMode) clear(); return pickMode; };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("click", nav, true);
    document.addEventListener("submit", nav, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("click", nav, true);
      document.removeEventListener("submit", nav, true);
      document.removeEventListener("keydown", key, true);
      delete window.__tachyonDmSetPickMode;
    };
  }, [bindingName, restorePickMode]);

  return <div ref={outline} id="tachyon-dm-root" aria-hidden="true" style={{ position: "fixed", display: "none", pointerEvents: "none", zIndex: 2_147_483_646, border: `2px solid ${focusColor}`, boxSizing: "border-box", borderRadius: "2px" }} />;
}

declare global {
  interface Window {
    __tachyonDmQueue?: string[];
    __tachyonDmSetPickMode?: (on: boolean) => boolean;
  }
}
