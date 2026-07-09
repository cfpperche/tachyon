export const PROTOTYPE_HTML_POLICY_VERSION = 1;
export const PROTOTYPE_HTML_MAX_BYTES = 512 * 1024;
export const PROTOTYPE_DATA_MAX_DECODED_BYTES = 256 * 1024;

export interface PrototypeHtmlValidation {
  html: string;
  byteSize: number;
  decodedDataBytes: number;
  policyVersion: typeof PROTOTYPE_HTML_POLICY_VERSION;
}

const FORBIDDEN_ELEMENT_RE = /<(?:form|iframe|frame|frameset|object|embed|base|portal)\b/i;
const FORBIDDEN_SCRIPT_TYPE_RE = /<script\b[^>]*\btype\s*=\s*(?:["']?)(?:importmap|speculationrules)\b/i;
const META_RE = /<meta\b[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const URL_ATTR_RE = /\b(src|href|action|formaction|poster|background|cite|data|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const STYLE_RE = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const DATA_URL_RE = /data:([^,]*),([^\s"')>]*)/gi;

/** Standalone, fail-closed policy for agent-authored prototype HTML. It intentionally does not call the
 * plugin entry validator: plugin UI has a different authority model and is a weaker policy floor. */
export function validatePrototypeHtml(html: string, mediaType = "text/html"): PrototypeHtmlValidation {
  if (mediaType.toLowerCase().split(";", 1)[0]?.trim() !== "text/html") throw new Error("prototype MIME must be text/html");
  if (typeof html !== "string") throw new Error("prototype HTML must be a string");
  const byteSize = Buffer.byteLength(html, "utf8");
  if (byteSize === 0) throw new Error("prototype HTML must not be empty");
  if (byteSize > PROTOTYPE_HTML_MAX_BYTES) throw new Error(`prototype HTML exceeds ${PROTOTYPE_HTML_MAX_BYTES} bytes`);
  if (html.includes("\0")) throw new Error("prototype HTML contains NUL");

  const normalized = normalizeMarkupForPolicy(html);
  if (FORBIDDEN_ELEMENT_RE.test(normalized)) throw new Error("prototype HTML contains a forbidden element");
  if (FORBIDDEN_SCRIPT_TYPE_RE.test(normalized)) throw new Error("prototype HTML contains a forbidden script type");
  if (/<(?:svg|math)\b/i.test(normalized)) throw new Error("prototype HTML cannot embed SVG or MathML markup");
  if (/\b(?:new\s+Worker|SharedWorker|ServiceWorker|navigator\.serviceWorker|importScripts)\b/i.test(normalized)) {
    throw new Error("prototype HTML contains worker code");
  }

  for (const meta of normalized.match(META_RE) ?? []) {
    if (/http-equiv\s*=\s*["']?\s*(?:refresh|content-security-policy)\b/i.test(meta)) {
      throw new Error("prototype HTML contains forbidden author policy or refresh");
    }
  }

  for (const tag of normalized.match(TAG_RE) ?? []) {
    if (/\b(?:on[a-z][a-z0-9_-]*)\s*=/i.test(tag)) throw new Error("prototype HTML contains an inline event handler");
    if (/^<\s*script\b/i.test(tag) && /\bsrc\s*=/i.test(tag)) throw new Error("prototype scripts must be inline");
    if (/^<\s*link\b/i.test(tag) && /\b(?:href|rel)\s*=/i.test(tag)) throw new Error("prototype HTML cannot load linked resources");
  }

  for (const match of normalized.matchAll(URL_ATTR_RE)) {
    const attribute = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (attribute === "srcset" && !/^data:image\/(?:png|jpeg|webp|gif)[;,]/i.test(value)) throw new Error("prototype HTML contains an external srcset");
    else assertSafePrototypeUrl(value);
  }
  for (const match of normalized.matchAll(STYLE_RE)) assertStyleUrls(match[1] ?? match[2] ?? match[3] ?? "");
  for (const match of normalized.matchAll(STYLE_BLOCK_RE)) assertStyleUrls(match[1] ?? "");

  let decodedDataBytes = 0;
  for (const match of normalized.matchAll(DATA_URL_RE)) {
    const descriptor = (match[1] ?? "").toLowerCase();
    const payload = match[2] ?? "";
    const mime = descriptor.split(";", 1)[0] ?? "";
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) throw new Error("prototype data URLs must be bounded raster images");
    let bytes: number;
    if (descriptor.split(";").includes("base64")) {
      if (!/^[a-z0-9+/]*={0,2}$/i.test(payload) || payload.length % 4 === 1) throw new Error("prototype contains invalid base64 data URL");
      bytes = Buffer.from(payload, "base64").byteLength;
    } else {
      try { bytes = Buffer.byteLength(decodeURIComponent(payload), "utf8"); }
      catch { throw new Error("prototype contains invalid encoded data URL"); }
    }
    decodedDataBytes += bytes;
    if (decodedDataBytes > PROTOTYPE_DATA_MAX_DECODED_BYTES) {
      throw new Error(`prototype decoded data exceeds ${PROTOTYPE_DATA_MAX_DECODED_BYTES} bytes`);
    }
  }

  return { html, byteSize, decodedDataBytes, policyVersion: PROTOTYPE_HTML_POLICY_VERSION };
}

function normalizeMarkupForPolicy(value: string): string {
  let out = value.replace(/&(?:colon|#0*58|#x0*3a);?/gi, ":").replace(/&(?:tab|newline|#0*9|#0*10|#x0*9|#x0*a);?/gi, "");
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch { break; }
  }
  return out.replace(/[\u0000-\u0020\u007f]+/g, (m) => m.includes(" ") ? " " : "");
}

function assertSafePrototypeUrl(raw: string): void {
  const value = normalizeMarkupForPolicy(raw).trim();
  if (!value || value.startsWith("#")) return;
  if (/^data:/i.test(value)) return;
  throw new Error("prototype HTML contains an external or privileged URL");
}

function assertStyleUrls(css: string): void {
  if (/@(?:import|namespace|supports\s*\([^)]*url)/i.test(css)) throw new Error("prototype CSS contains a forbidden external rule");
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi)) {
    assertSafePrototypeUrl(match[1] ?? match[2] ?? match[3] ?? "");
  }
}
