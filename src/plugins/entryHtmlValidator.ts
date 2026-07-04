export type EntryHtmlValidationResult = { ok: true } | { ok: false; reason: string };

const MAX_DATA_URL_CHARS = 256 * 1024;

const TAG_RE = /<\s*([a-zA-Z][\w:-]*)([^>]*)>/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const CSS_URL_RE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/gi;
const SRCSET_CANDIDATE_RE = /(?:^|,)\s*((?:data:[^\s]+)|[^,\s]+)(?:\s+[^,]+)?/gi;
const REMOTE_OR_PRIVILEGED_URL_RE = /(?:https?:|wss?:|ftp:|file:|blob:|vscode-webview-resource:|vscode-resource:|\/\/)/i;
const WORKER_RE = /\b(?:new\s+)?(?:Worker|SharedWorker|ServiceWorker)\b|\bnavigator\s*\.\s*serviceWorker\b|\bimportScripts\s*\(/i;

const URL_ATTRS = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "profile",
  "src",
  "usemap",
]);

const BLOCKED_ELEMENTS = new Set(["iframe", "object", "embed"]);

export function validateEntryHtml(html: string): EntryHtmlValidationResult {
  const activeHtml = html.replace(COMMENT_RE, "");

  for (const { tag, attrs } of scanTags(activeHtml)) {
    if (BLOCKED_ELEMENTS.has(tag)) {
      return reject(`<${tag}> is not allowed in a self-contained plugin entry`);
    }

    if (tag === "script") {
      const src = getAttr(attrs, "src");
      if (src !== undefined) {
        return reject("<script src> is not allowed; plugin entry scripts must be inline");
      }
      const type = getAttr(attrs, "type");
      if (type !== undefined && isImportMapType(type)) {
        return reject("import maps are not allowed in plugin entry HTML");
      }
    }

    if (tag === "link" && getAttr(attrs, "href") !== undefined) {
      return reject("<link href> is not allowed; use inline <style> instead");
    }

    if (tag === "form" && getAttr(attrs, "action") !== undefined) {
      return reject("<form action> is not allowed in plugin entry HTML");
    }

    const metaRefreshReason = validateMetaRefresh(tag, attrs);
    if (metaRefreshReason) return reject(metaRefreshReason);

    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const value = attr.value ?? "";
      if (name === "style") {
        const cssReason = validateCssUrls(value, "inline style");
        if (cssReason) return reject(cssReason);
        continue;
      }
      if (isUrlAttribute(name)) {
        const reason = validateUrlAttribute(tag, name, value);
        if (reason) return reject(reason);
      }
    }
  }

  for (const script of scanBlocks(activeHtml, SCRIPT_BLOCK_RE)) {
    const decoded = decodeHtmlEntities(script);
    if (REMOTE_OR_PRIVILEGED_URL_RE.test(decoded)) {
      return reject("remote or privileged URL literal is not allowed in inline script");
    }
    if (WORKER_RE.test(decoded)) {
      return reject("workers are not allowed in plugin entry HTML");
    }
  }

  for (const style of scanBlocks(activeHtml, STYLE_BLOCK_RE)) {
    const reason = validateCssUrls(decodeHtmlEntities(style), "<style>");
    if (reason) return reject(reason);
  }

  return { ok: true };
}

function reject(reason: string): EntryHtmlValidationResult {
  return { ok: false, reason };
}

function* scanTags(html: string): Generator<{ tag: string; attrs: HtmlAttr[] }> {
  TAG_RE.lastIndex = 0;
  for (let match = TAG_RE.exec(html); match !== null; match = TAG_RE.exec(html)) {
    const tag = match[1].toLowerCase();
    const rawAttrs = match[2] ?? "";
    yield { tag, attrs: parseAttrs(rawAttrs) };
  }
}

type HtmlAttr = { name: string; value?: string };

function parseAttrs(raw: string): HtmlAttr[] {
  const attrs: HtmlAttr[] = [];
  ATTR_RE.lastIndex = 0;
  for (let match = ATTR_RE.exec(raw); match !== null; match = ATTR_RE.exec(raw)) {
    attrs.push({ name: match[1], value: match[2] ?? match[3] ?? match[4] });
  }
  return attrs;
}

function getAttr(attrs: HtmlAttr[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return attrs.find((attr) => attr.name.toLowerCase() === wanted)?.value ?? undefined;
}

function isImportMapType(type: string): boolean {
  return decodeHtmlEntities(type).trim().toLowerCase() === "importmap";
}

function validateMetaRefresh(tag: string, attrs: HtmlAttr[]): string | undefined {
  if (tag !== "meta") return undefined;
  const httpEquiv = getAttr(attrs, "http-equiv");
  if (httpEquiv === undefined || decodeHtmlEntities(httpEquiv).trim().toLowerCase() !== "refresh") {
    return undefined;
  }
  const content = getAttr(attrs, "content") ?? "";
  if (/url\s*=/i.test(decodeHtmlEntities(content))) {
    return "<meta http-equiv=\"refresh\"> with a URL is not allowed";
  }
  return undefined;
}

function isUrlAttribute(name: string): boolean {
  return URL_ATTRS.has(name) || name.endsWith(":href") || name === "srcset";
}

function validateUrlAttribute(tag: string, attr: string, rawValue: string): string | undefined {
  if (tag === "script" && attr === "src") {
    return "<script src> is not allowed; plugin entry scripts must be inline";
  }
  if (tag === "link" && attr === "href") {
    return "<link href> is not allowed; use inline <style> instead";
  }
  if (tag === "form" && attr === "action") {
    return "<form action> is not allowed in plugin entry HTML";
  }

  const value = attr === "srcset" ? decodeHtmlEntities(rawValue).trim().toLowerCase() : normalizeUrl(rawValue);
  if (value.length === 0 || value.startsWith("#")) return undefined;

  if (attr === "srcset") {
    for (const candidate of parseSrcset(value)) {
      const reason = validateSingleUrl(tag, attr, candidate);
      if (reason) return reason;
    }
    return undefined;
  }

  return validateSingleUrl(tag, attr, value);
}

function parseSrcset(value: string): string[] {
  const candidates: string[] = [];
  SRCSET_CANDIDATE_RE.lastIndex = 0;
  for (let match = SRCSET_CANDIDATE_RE.exec(value); match !== null; match = SRCSET_CANDIDATE_RE.exec(value)) {
    candidates.push(match[1]);
  }
  return candidates;
}

function validateSingleUrl(tag: string, attr: string, value: string): string | undefined {
  if (value.startsWith("data:")) {
    if (value.length > MAX_DATA_URL_CHARS) {
      return `data: URL in ${tag} ${attr} exceeds the self-contained asset size cap`;
    }
    return undefined;
  }
  if (isPrivilegedUrl(value)) {
    return `privileged URL is not allowed in ${tag} ${attr}`;
  }
  if (isRemoteUrl(value)) {
    return `remote URL is not allowed in ${tag} ${attr}`;
  }
  return `external resource URL is not allowed in ${tag} ${attr}; use data: assets only`;
}

function validateCssUrls(css: string, context: string): string | undefined {
  CSS_URL_RE.lastIndex = 0;
  for (let match = CSS_URL_RE.exec(css); match !== null; match = CSS_URL_RE.exec(css)) {
    const value = normalizeUrl(match[1] ?? match[2] ?? match[3] ?? "");
    if (value.length === 0 || value.startsWith("#")) continue;
    if (value.startsWith("data:")) {
      if (value.length > MAX_DATA_URL_CHARS) {
        return `data: URL in ${context} exceeds the self-contained asset size cap`;
      }
      continue;
    }
    if (isPrivilegedUrl(value)) return `privileged URL is not allowed in ${context}`;
    if (isRemoteUrl(value)) return `remote URL is not allowed in ${context}`;
    return `external resource URL is not allowed in ${context}; use data: assets only`;
  }
  return undefined;
}

function* scanBlocks(html: string, re: RegExp): Generator<string> {
  re.lastIndex = 0;
  for (let match = re.exec(html); match !== null; match = re.exec(html)) {
    yield match[1] ?? "";
  }
}

function normalizeUrl(value: string): string {
  return decodeHtmlEntities(value).replace(/[\u0000-\u001f\u007f\s]+/g, "").trim().toLowerCase();
}

function isPrivilegedUrl(value: string): boolean {
  return value.startsWith("vscode-webview-resource:") || value.startsWith("vscode-resource:");
}

function isRemoteUrl(value: string): boolean {
  return /^(?:https?:|wss?:|ftp:|file:|blob:|\/\/)/i.test(value);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(colon|amp|quot|apos|lt|gt);/gi, (_m, name: string) => {
      switch (name.toLowerCase()) {
        case "colon":
          return ":";
        case "amp":
          return "&";
        case "quot":
          return "\"";
        case "apos":
          return "'";
        case "lt":
          return "<";
        case "gt":
          return ">";
        default:
          return "";
      }
    });
}
