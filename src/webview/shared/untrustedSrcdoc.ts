export type UntrustedSrcdocMode = "plugin" | "prototype-static" | "prototype-interactive";

const CSP_META_RE = /<meta\b(?=[^>]*http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy))[^>]*>/gi;
const HEAD_OPEN_RE = /<head\b[^>]*>/i;
const SCRIPT_OPEN_RE = /<script\b(?![^>]*\bsrc\s*=)(?![^>]*\bnonce\s*=)([^>]*)>/gi;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STATIC_POINTER_GUARD = `<style data-tachyon-static-prototype-guard>html,body{pointer-events:auto!important;}body *{pointer-events:none!important;}</style>`;

export function assembleUntrustedSrcdoc(html: string, options: { mode: UntrustedSrcdocMode; nonce?: string }): string {
  const interactive = options.mode !== "prototype-static";
  const nonce = options.nonce ?? "";
  if (interactive && !nonce) throw new Error("untrusted srcdoc requires a non-empty nonce");
  const img = options.mode === "plugin" ? "data:" : "data:";
  const csp = [
    "default-src 'none'",
    `img-src ${img}`,
    "style-src 'unsafe-inline'",
    ...(interactive ? [`script-src 'nonce-${escapeHtmlAttr(nonce)}'`] : ["script-src 'none'"]),
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'none'",
  ].join("; ") + ";";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  let body = html.replace(CSP_META_RE, "");
  body = interactive
    ? body.replace(SCRIPT_OPEN_RE, `<script nonce="${escapeHtmlAttr(nonce)}"$1>`)
    : body.replace(SCRIPT_BLOCK_RE, "");
  const staticGuard = options.mode === "prototype-static" ? `\n${STATIC_POINTER_GUARD}` : "";
  if (HEAD_OPEN_RE.test(body)) return body.replace(HEAD_OPEN_RE, (m) => `${m}\n${meta}${staticGuard}`);
  return `<!doctype html><html><head>${meta}${staticGuard}</head><body>${body}</body></html>`;
}

export function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
