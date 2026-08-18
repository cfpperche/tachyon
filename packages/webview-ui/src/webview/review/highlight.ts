// Same highlight.js door Activity uses (markdownEngine.ts:13). Copied rather than imported so
// this surface does not pull markdown-it into the review bundle.
import hljs from "highlight.js/lib/common";

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));

/** Syntax-highlight to an escaped HTML string (hljs escapes the code). */
export function highlight(code: string, lang?: string): string {
  if (code.length > 20000) return esc(code); // skip the costly highlightAuto on huge blocks (perf)
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  } catch {
    return esc(code);
  }
}

/** hljs language for a path's extension (best-effort; undefined → highlightAuto). */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", json: "json", md: "markdown", sh: "bash", bash: "bash", zsh: "bash", css: "css", scss: "scss",
  html: "xml", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql",
};

export function langFromPath(path?: string): string | undefined {
  const ext = path?.split("/").pop()?.split(".").pop()?.toLowerCase();
  return ext ? LANG_BY_EXT[ext] : undefined;
}

export function escapeText(text: string): string {
  return esc(text);
}
