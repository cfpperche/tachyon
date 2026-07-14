export const CODEX_CATALOG_MAX_BYTES = 8 * 1024 * 1024;
export const CODEX_CATALOG_MAX_DEPTH = 64;
export const CODEX_CATALOG_MAX_SLUGS = 512;
export const CODEX_CATALOG_MAX_SLUG_LENGTH = 128;

const MAX_RETAINED_STRING_SOURCE = 1024;
const MAX_ATOM_SOURCE = 128;
const UNSAFE_SLUG_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

export type CodexCatalogStreamResult =
  | { state: "ok"; slugs: string[] }
  | { state: "malformed" | "oversized" };

type ObjectState = "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
type ArrayState = "valueOrEnd" | "value" | "commaOrEnd";
type FrameRole = "root" | "models" | "model" | "other";

interface ObjectFrame {
  kind: "object";
  state: ObjectState;
  role: FrameRole;
  key?: string;
  model?: { slug?: string; visibility?: string };
}

interface ArrayFrame {
  kind: "array";
  state: ArrayState;
  role: FrameRole;
}

type Frame = ObjectFrame | ArrayFrame;
type ScalarContext = { model?: NonNullable<ObjectFrame["model"]>; key?: string };

/**
 * Streaming validator/projection for `codex debug models`.
 *
 * It validates the complete JSON document while retaining only bounded token
 * fragments and selectable model slugs. Large instructions/descriptions are
 * scanned for JSON correctness but never accumulated in memory.
 */
export class CodexCatalogStreamParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly stack: Frame[] = [];
  private rootState: "value" | "done" = "value";
  private failure?: "malformed" | "oversized";
  private bytes = 0;

  private token: "none" | "string" | "atom" = "none";
  private stringRole: "key" | "value" = "value";
  private stringSource = "";
  private stringOverflow = false;
  private stringEscape = false;
  private unicodeRemaining = 0;
  private scalarContext?: ScalarContext;
  private atomSource = "";

  private modelsSeen = false;
  private modelsIsArray = false;
  private selectableEntries = 0;
  private slugs = new Set<string>();

  write(chunk: Buffer): "continue" | "malformed" | "oversized" {
    if (this.failure) return this.failure;
    this.bytes += chunk.length;
    if (this.bytes > CODEX_CATALOG_MAX_BYTES) return this.setFailure("oversized");
    try {
      this.consume(this.decoder.decode(chunk, { stream: true }));
    } catch {
      return this.setFailure("malformed");
    }
    return this.failure ?? "continue";
  }

  finish(): CodexCatalogStreamResult {
    if (!this.failure) {
      try {
        this.consume(this.decoder.decode());
        if (this.token === "atom") this.finishAtom();
      } catch {
        this.setFailure("malformed");
      }
    }
    if (!this.failure && (this.token !== "none" || this.stack.length !== 0 || this.rootState !== "done" || !this.modelsSeen || !this.modelsIsArray)) {
      this.setFailure("malformed");
    }
    return this.failure ? { state: this.failure } : { state: "ok", slugs: [...this.slugs] };
  }

  private consume(text: string): void {
    for (let index = 0; index < text.length && !this.failure; index++) {
      const char = text[index]!;
      if (this.token === "string") {
        this.consumeString(char);
        continue;
      }
      if (this.token === "atom") {
        if (isJsonWhitespace(char) || char === "," || char === "]" || char === "}") {
          this.finishAtom();
          if (!this.failure) index--;
        } else {
          if (this.atomSource.length >= MAX_ATOM_SOURCE) this.setFailure("oversized");
          else this.atomSource += char;
        }
        continue;
      }
      if (isJsonWhitespace(char)) continue;
      if (char === '"') {
        this.startString();
        continue;
      }
      if (char === "{") {
        this.startContainer("object");
        continue;
      }
      if (char === "[") {
        this.startContainer("array");
        continue;
      }
      if (char === "}") {
        this.closeContainer("object");
        continue;
      }
      if (char === "]") {
        this.closeContainer("array");
        continue;
      }
      if (char === ":") {
        const frame = this.top();
        if (frame?.kind !== "object" || frame.state !== "colon") this.setFailure("malformed");
        else frame.state = "value";
        continue;
      }
      if (char === ",") {
        const frame = this.top();
        if (!frame || frame.state !== "commaOrEnd") this.setFailure("malformed");
        else frame.state = frame.kind === "object" ? "key" : "value";
        continue;
      }
      if (/[-0-9tfn]/.test(char)) {
        this.scalarContext = this.beginValue("scalar");
        if (!this.failure) {
          this.token = "atom";
          this.atomSource = char;
        }
        continue;
      }
      this.setFailure("malformed");
    }
  }

  private startString(): void {
    const frame = this.top();
    const keyPosition = frame?.kind === "object" && (frame.state === "keyOrEnd" || frame.state === "key");
    if (keyPosition) this.stringRole = "key";
    else {
      this.scalarContext = this.beginValue("string");
      if (this.failure) return;
      this.stringRole = "value";
    }
    this.token = "string";
    this.stringSource = "";
    this.stringOverflow = false;
    this.stringEscape = false;
    this.unicodeRemaining = 0;
  }

  private consumeString(char: string): void {
    if (this.unicodeRemaining > 0) {
      if (!/[0-9A-Fa-f]/.test(char)) return void this.setFailure("malformed");
      this.retainStringChar(char);
      this.unicodeRemaining--;
      if (this.unicodeRemaining === 0) this.stringEscape = false;
      return;
    }
    if (this.stringEscape) {
      if (!/["\\/bfnrtu]/.test(char)) return void this.setFailure("malformed");
      this.retainStringChar(char);
      if (char === "u") this.unicodeRemaining = 4;
      else this.stringEscape = false;
      return;
    }
    if (char === '"') return void this.finishString();
    if (char === "\\") {
      this.retainStringChar(char);
      this.stringEscape = true;
      return;
    }
    if (char.charCodeAt(0) < 0x20) return void this.setFailure("malformed");
    this.retainStringChar(char);
  }

  private retainStringChar(char: string): void {
    if (this.stringOverflow) return;
    if (this.stringSource.length + char.length > MAX_RETAINED_STRING_SOURCE) {
      this.stringOverflow = true;
      this.stringSource = "";
    } else this.stringSource += char;
  }

  private finishString(): void {
    if (this.stringEscape || this.unicodeRemaining > 0) return void this.setFailure("malformed");
    let value: string | undefined;
    if (!this.stringOverflow) {
      try { value = JSON.parse(`"${this.stringSource}"`) as string; }
      catch { return void this.setFailure("malformed"); }
    }
    this.token = "none";
    if (this.stringRole === "key") {
      const frame = this.top();
      if (frame?.kind !== "object" || (frame.state !== "keyOrEnd" && frame.state !== "key")) return void this.setFailure("malformed");
      frame.key = value;
      frame.state = "colon";
    } else {
      this.captureStringValue(value);
      this.completeValue();
    }
    this.stringSource = "";
    this.scalarContext = undefined;
  }

  private finishAtom(): void {
    const atom = this.atomSource;
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(atom)) return void this.setFailure("malformed");
    this.token = "none";
    this.atomSource = "";
    this.completeValue();
    this.scalarContext = undefined;
  }

  private startContainer(kind: "object" | "array"): void {
    const context = this.beginValue(kind);
    if (this.failure) return;
    if (this.stack.length >= CODEX_CATALOG_MAX_DEPTH) return void this.setFailure("oversized");
    let role: FrameRole = "other";
    if (this.stack.length === 0) role = kind === "object" ? "root" : "other";
    else {
      const parent = this.top()!;
      if (parent.kind === "object" && parent.role === "root" && parent.key === "models" && kind === "array") role = "models";
      else if (parent.kind === "array" && parent.role === "models" && kind === "object") role = "model";
    }
    if (kind === "object") this.stack.push({ kind, state: "keyOrEnd", role, ...(role === "model" ? { model: {} } : {}) });
    else this.stack.push({ kind, state: "valueOrEnd", role });
    this.scalarContext = context;
  }

  private closeContainer(kind: "object" | "array"): void {
    const frame = this.top();
    if (!frame || frame.kind !== kind) return void this.setFailure("malformed");
    const closable = frame.state === "commaOrEnd" || (kind === "object" ? frame.state === "keyOrEnd" : frame.state === "valueOrEnd");
    if (!closable) return void this.setFailure("malformed");
    this.stack.pop();
    if (frame.kind === "object" && frame.role === "model") this.finishModel(frame.model!);
    this.completeValue();
  }

  private beginValue(type: "string" | "scalar" | "object" | "array"): ScalarContext | undefined {
    const parent = this.top();
    if (!parent) {
      if (this.rootState !== "value") this.setFailure("malformed");
      return undefined;
    }
    const expected = parent.kind === "object"
      ? parent.state === "value"
      : parent.state === "valueOrEnd" || parent.state === "value";
    if (!expected) {
      this.setFailure("malformed");
      return undefined;
    }
    if (parent.kind === "object" && parent.role === "root" && parent.key === "models") {
      this.modelsSeen = true;
      this.modelsIsArray = type === "array";
      this.selectableEntries = 0;
      this.slugs = new Set<string>();
    }
    if (parent.kind === "object" && parent.role === "model" && (parent.key === "slug" || parent.key === "visibility")) {
      parent.model![parent.key] = undefined;
      return { model: parent.model, key: parent.key };
    }
    return undefined;
  }

  private captureStringValue(value: string | undefined): void {
    const context = this.scalarContext;
    if (!context?.model || !context.key || value === undefined) return;
    if (context.key === "slug") {
      context.model.slug = value.length <= CODEX_CATALOG_MAX_SLUG_LENGTH && !UNSAFE_SLUG_CHARS.test(value) ? value : undefined;
    }
    else if (context.key === "visibility") context.model.visibility = value;
  }

  private completeValue(): void {
    const parent = this.top();
    if (!parent) {
      if (this.rootState !== "value") return void this.setFailure("malformed");
      this.rootState = "done";
      return;
    }
    if (parent.kind === "object") {
      if (parent.state !== "value") return void this.setFailure("malformed");
      parent.state = "commaOrEnd";
    } else {
      if (parent.state !== "valueOrEnd" && parent.state !== "value") return void this.setFailure("malformed");
      parent.state = "commaOrEnd";
    }
  }

  private finishModel(model: NonNullable<ObjectFrame["model"]>): void {
    if (model.visibility !== "list" || model.slug === undefined) return;
    this.selectableEntries++;
    if (this.selectableEntries > CODEX_CATALOG_MAX_SLUGS) return void this.setFailure("oversized");
    this.slugs.add(model.slug);
  }

  private top(): Frame | undefined { return this.stack[this.stack.length - 1]; }

  private setFailure(state: "malformed" | "oversized"): "malformed" | "oversized" {
    this.failure ??= state;
    return this.failure;
  }
}
