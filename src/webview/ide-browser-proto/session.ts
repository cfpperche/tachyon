import { ideBrowserHeadedPreferred, resolveIdeBrowserChrome } from "./chrome.js";
import type { IdeBrowserPickPayload } from "./types.js";

/** Minimal CDP session surface used for Page.startScreencast. */
type ProtoCdp = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: ScreencastFrameEvent) => void): void;
  off?(event: string, handler: (params: ScreencastFrameEvent) => void): void;
};

type ScreencastFrameEvent = {
  data: string;
  sessionId: number;
  metadata?: { offsetTop?: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number };
};

/** Minimal puppeteer surface — types only via structural typing (puppeteer-core is ESM). */
type ProtoPage = {
  url(): string;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload(opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  setViewport(v: { width: number; height: number; deviceScaleFactor?: number }): Promise<unknown>;
  mouse: { click(x: number, y: number): Promise<void> };
  evaluate<T>(fn: (x: number, y: number) => T, x: number, y: number): Promise<T>;
  createCDPSession(): Promise<ProtoCdp>;
};
type ProtoBrowser = {
  newPage(): Promise<ProtoPage>;
  close(): Promise<void>;
};

export type FramePayload = {
  dataUrl: string;
  cssW: number;
  cssH: number;
  url: string;
  /** How this frame was produced */
  source: "screencast" | "screenshot";
  /** Bitmap scale relative to CSS viewport (deviceScaleFactor). */
  dpr: number;
};

export type ScreencastFormat = "png" | "jpeg";

export type IdeBrowserSessionOptions = {
  /** Default start URL */
  startUrl?: string;
  /** Viewport CSS pixels (layout). Default 1440×900 for design work. */
  width?: number;
  height?: number;
  /**
   * Device pixel ratio for sharper UI text/edges (default 2).
   * Override: TACHYON_IDE_BROWSER_DPR
   */
  deviceScaleFactor?: number;
  /**
   * Screencast pixel format. Default **png** (no JPEG block artifacts — better for UI design).
   * Override: TACHYON_IDE_BROWSER_SC_FORMAT=png|jpeg
   */
  screencastFormat?: ScreencastFormat;
  /**
   * JPEG quality 0–100 (only when format is jpeg). Default 92.
   * Override: TACHYON_IDE_BROWSER_SC_QUALITY
   */
  screencastQuality?: number;
  /**
   * Deliver every Nth CDP frame (1 = max rate). Default 1.
   * Override: TACHYON_IDE_BROWSER_SC_EVERY_NTH
   */
  screencastEveryNthFrame?: number;
  onFrame?: (frame: FramePayload) => void;
  onStatus?: (text: string, opts?: { error?: boolean; url?: string }) => void;
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function envFormat(fallback: ScreencastFormat): ScreencastFormat {
  const raw = (process.env.TACHYON_IDE_BROWSER_SC_FORMAT || "").trim().toLowerCase();
  if (raw === "jpeg" || raw === "jpg") return "jpeg";
  if (raw === "png") return "png";
  return fallback;
}

/**
 * One external Chrome session driven over CDP for the IDE browser prototype.
 * Stream path: Page.startScreencast (high-res for UI design) with screenshot fallback.
 */
export class IdeBrowserSession {
  private browser: ProtoBrowser | undefined;
  private page: ProtoPage | undefined;
  private cdp: ProtoCdp | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private streaming = false;
  private streamMode: "screencast" | "screenshot" | "off" = "off";
  private cssW: number;
  private cssH: number;
  private dpr: number;
  private frameMime: "image/png" | "image/jpeg" = "image/png";
  private readonly opts: IdeBrowserSessionOptions;
  private closed = false;
  /** Coalesce CDP frames so a slow webview does not backlog payloads. */
  private pendingB64: string | null = null;
  private flushScheduled = false;
  private readonly onScreencastFrame: (event: ScreencastFrameEvent) => void;
  private framesDelivered = 0;
  private lastFpsAt = 0;
  private framesInWindow = 0;

  constructor(opts: IdeBrowserSessionOptions = {}) {
    this.opts = opts;
    this.cssW = opts.width ?? envInt("TACHYON_IDE_BROWSER_WIDTH", 1440, 800, 2560);
    this.cssH = opts.height ?? envInt("TACHYON_IDE_BROWSER_HEIGHT", 900, 600, 1600);
    this.dpr = opts.deviceScaleFactor ?? envInt("TACHYON_IDE_BROWSER_DPR", 2, 1, 3);
    this.onScreencastFrame = (event) => {
      void this.handleScreencastFrame(event);
    };
  }

  get url(): string {
    return this.page?.url() ?? "";
  }

  get viewport(): { cssW: number; cssH: number; dpr: number } {
    return { cssW: this.cssW, cssH: this.cssH, dpr: this.dpr };
  }

  get streamSource(): "screencast" | "screenshot" | "off" {
    return this.streamMode;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    const executablePath = resolveIdeBrowserChrome();
    const headed = ideBrowserHeadedPreferred();
    this.opts.onStatus?.(
      `Launching Chrome (${headed ? "headed" : "headless"}) dpr=${this.dpr} ${this.cssW}×${this.cssH}: ${executablePath}`,
    );

    // puppeteer-core is ESM-only under Node16 resolution — dynamic import required from CJS shell.
    const mod = await import("puppeteer-core");
    const launch = (mod as { default?: { launch: (o: unknown) => Promise<ProtoBrowser> }; launch?: (o: unknown) => Promise<ProtoBrowser> }).default?.launch
      ?? (mod as { launch: (o: unknown) => Promise<ProtoBrowser> }).launch;
    const winW = Math.round(this.cssW * this.dpr);
    const winH = Math.round(this.cssH * this.dpr);
    this.browser = await launch({
      executablePath,
      headless: headed ? false : true,
      defaultViewport: {
        width: this.cssW,
        height: this.cssH,
        deviceScaleFactor: this.dpr,
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        `--window-size=${winW},${winH}`,
        // Prefer crisp font rasterization in headless where available.
        "--font-render-hinting=full",
      ],
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({
      width: this.cssW,
      height: this.cssH,
      deviceScaleFactor: this.dpr,
    });
    const start = this.opts.startUrl?.trim() || "https://example.com";
    await this.navigate(start);
    await this.startStream();
  }

  async navigate(rawUrl: string): Promise<void> {
    if (!this.page) throw new Error("Session not started");
    let url = rawUrl.trim();
    if (!url) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      url = `https://${url}`;
    }
    this.opts.onStatus?.(`Navigating…`, { url });
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.opts.onStatus?.(
        this.streamMode === "screencast" ? "Ready (CDP screencast hi-res)" : "Ready",
        { url: this.page.url() },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onStatus?.(msg, { error: true, url: this.page.url() });
    }
  }

  async reload(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      this.opts.onStatus?.(
        this.streamMode === "screencast" ? "Reloaded (CDP screencast hi-res)" : "Reloaded",
        { url: this.page.url() },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onStatus?.(msg, { error: true });
    }
  }

  async clickAt(cssX: number, cssY: number): Promise<void> {
    if (!this.page) return;
    // Puppeteer mouse API is in CSS pixels regardless of deviceScaleFactor.
    await this.page.mouse.click(cssX, cssY);
  }

  async pickAt(cssX: number, cssY: number): Promise<IdeBrowserPickPayload | null> {
    if (!this.page) return null;
    const url = this.page.url();
    const raw = await this.page.evaluate(
      (x: number, y: number) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const className =
          typeof el.className === "string"
            ? el.className
            : (el.getAttribute("class") || "");
        return {
          tag: el.tagName,
          id: el.id || "",
          className,
          text: (el.innerText || el.textContent || "").trim().slice(0, 240),
          html: (el.outerHTML || "").slice(0, 4000),
          bounds: { x: r.x, y: r.y, w: r.width, h: r.height },
          styles: {
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            display: cs.display,
            padding: cs.padding,
            margin: cs.margin,
            border: cs.border,
          },
        };
      },
      cssX,
      cssY,
    );
    if (!raw) return null;
    return {
      ...raw,
      url,
      capturedAt: new Date().toISOString(),
    };
  }

  private async startStream(): Promise<void> {
    if (this.streaming || !this.page) return;
    this.streaming = true;

    const format = this.opts.screencastFormat ?? envFormat("png");
    const quality = this.opts.screencastQuality
      ?? envInt("TACHYON_IDE_BROWSER_SC_QUALITY", 92, 50, 100);
    const everyNth = this.opts.screencastEveryNthFrame
      ?? envInt("TACHYON_IDE_BROWSER_SC_EVERY_NTH", 1, 1, 10);
    // Do NOT cap below device pixels or Chrome downscales → soft UI text.
    const maxWidth = Math.round(this.cssW * this.dpr);
    const maxHeight = Math.round(this.cssH * this.dpr);
    this.frameMime = format === "jpeg" ? "image/jpeg" : "image/png";

    try {
      this.cdp = await this.page.createCDPSession();
      this.cdp.on("Page.screencastFrame", this.onScreencastFrame);
      const params: Record<string, unknown> = {
        format,
        maxWidth,
        maxHeight,
        everyNthFrame: everyNth,
      };
      if (format === "jpeg") params.quality = quality;
      await this.cdp.send("Page.startScreencast", params);
      this.streamMode = "screencast";
      this.lastFpsAt = Date.now();
      this.opts.onStatus?.(
        `Stream: CDP ${format}${format === "jpeg" ? ` q=${quality}` : ""} dpr=${this.dpr} ` +
          `${this.cssW}×${this.cssH} css → ${maxWidth}×${maxHeight}px everyNth=${everyNth}`,
        { url: this.page.url() },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onStatus?.(`Screencast failed (${msg}); falling back to PNG screenshots`, {
        error: true,
        url: this.page.url(),
      });
      this.startScreenshotFallback();
    }
  }

  private startScreenshotFallback(): void {
    this.streamMode = "screenshot";
    this.frameMime = "image/png";
    // ~12 fps PNG poll — heavier but sharp when screencast unavailable.
    const intervalMs = envInt("TACHYON_IDE_BROWSER_SC_FALLBACK_MS", 80, 40, 500);
    this.timer = setInterval(() => {
      void this.captureScreenshotOnce();
    }, intervalMs);
  }

  private async handleScreencastFrame(event: ScreencastFrameEvent): Promise<void> {
    if (this.closed || !this.cdp) return;
    // Ack first so Chrome keeps producing frames (backpressure contract).
    try {
      await this.cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    } catch {
      return;
    }
    if (!event.data || !this.opts.onFrame) return;

    this.pendingB64 = event.data;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.closed || !this.pendingB64 || !this.opts.onFrame || !this.page) return;
      const b64 = this.pendingB64;
      this.pendingB64 = null;
      this.noteFrame();
      this.opts.onFrame({
        dataUrl: `data:${this.frameMime};base64,${b64}`,
        cssW: this.cssW,
        cssH: this.cssH,
        url: this.page.url(),
        source: "screencast",
        dpr: this.dpr,
      });
    });
  }

  private noteFrame(): void {
    this.framesDelivered += 1;
    this.framesInWindow += 1;
    const now = Date.now();
    if (now - this.lastFpsAt >= 2000) {
      const fps = (this.framesInWindow * 1000) / (now - this.lastFpsAt);
      this.framesInWindow = 0;
      this.lastFpsAt = now;
      if (this.page && this.streamMode === "screencast") {
        this.opts.onStatus?.(
          `Screencast ~${fps.toFixed(0)} fps ${this.frameMime} dpr=${this.dpr} (delivered ${this.framesDelivered})`,
          { url: this.page.url() },
        );
      }
    }
  }

  private async captureScreenshotOnce(): Promise<void> {
    if (this.closed || !this.page || !this.opts.onFrame) return;
    try {
      const page = this.page as ProtoPage & {
        screenshot(opts: {
          type?: string;
          quality?: number;
          encoding?: string;
          captureBeyondViewport?: boolean;
        }): Promise<string | Uint8Array>;
      };
      const buf = await page.screenshot({
        type: "png",
        encoding: "base64",
        captureBeyondViewport: false,
      });
      const b64 = typeof buf === "string" ? buf : Buffer.from(buf).toString("base64");
      this.noteFrame();
      this.opts.onFrame({
        dataUrl: `data:image/png;base64,${b64}`,
        cssW: this.cssW,
        cssH: this.cssH,
        url: this.page.url(),
        source: "screenshot",
        dpr: this.dpr,
      });
    } catch {
      // navigating
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.cdp) {
      try {
        this.cdp.off?.("Page.screencastFrame", this.onScreencastFrame);
      } catch {
        /* ignore */
      }
      try {
        await this.cdp.send("Page.stopScreencast");
      } catch {
        /* ignore */
      }
      this.cdp = undefined;
    }
    this.streaming = false;
    this.streamMode = "off";
    this.pendingB64 = null;
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.browser = undefined;
    this.page = undefined;
  }
}
