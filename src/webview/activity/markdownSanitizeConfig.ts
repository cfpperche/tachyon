/**
 * spec 245/335 — the DOMPurify configuration `MarkdownView` sanitizes with, pulled out as a pure/DOM-free
 * constant so it's unit-testable in Node (DOMPurify itself needs a real `window` and cannot be imported here —
 * see markdownEngine.test.ts's node-testable-layer note). `ALLOWED_URI_REGEXP` is the defense-in-depth layer
 * markdown-it's own link validation doesn't cover: it blocks `command:`/`vbscript:`/`data:`/`file:` links, not
 * just `javascript:` (dueto F9 — the Task Detail markdown body needs the same hardening the Handoff/Activity
 * views already carry).
 */

export const SANITIZE_ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|#)/i;

export const SANITIZE_OPTIONS = {
  ADD_ATTR: ["target"],
  ALLOWED_URI_REGEXP: SANITIZE_ALLOWED_URI_REGEXP,
};
