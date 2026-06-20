// markdown-it-texmath / markdown-it-task-lists ship without TS types — minimal ambient declarations,
// in types/ so BOTH tsconfig.json (engine pulled in by the vitest test) and tsconfig.webview.json see them.
declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, opts?: unknown) => void;
  export default plugin;
}
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: (md: MarkdownIt, opts?: unknown) => void;
  export default plugin;
}
