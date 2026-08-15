import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyHostLag,
  formatHostLagLog,
  localizeHostLagNotice,
  shouldNotifyHostLag,
} from "../../apps/vscode-extension/src/workspace/hostEventLoopLag.js";

const FORBIDDEN_NOTICE = /Bridge recovery|command palette/i;
const FORBIDDEN_SOURCE = /Bridge recovery/i;
const EXT = path.resolve(__dirname, "../../apps/vscode-extension/src/extension.ts");
const BUNDLE = path.resolve(__dirname, "../../apps/vscode-extension/l10n/bundle.l10n.pt-br.json");

const l10n = { t: (message: string, ...args: Array<string | number | boolean>) => message.replace("{0}", String(args[0])) };

describe("t-0bf709 host event-loop lag classifier", () => {
  it("high CPU fraction during a late tick is sync-work", () => {
    const sample = classifyHostLag({
      wallLagMs: 6079,
      hrLagMs: 6060,
      eluActiveMs: 6200,
      eluIdleMs: 4800,
      cpuMs: 6100,
      loadavg1: 2.2,
      cpuCount: 24,
      runDelayMs: 4,
    });
    expect(sample.cause).toBe("sync-work");
    expect(shouldNotifyHostLag(sample)).toBe(true);
    expect(localizeHostLagNotice(l10n, sample.cause, sample.wallLagMs)).toMatch(/busy for 6079ms/);
    expect(localizeHostLagNotice(l10n, sample.cause, sample.wallLagMs)).not.toMatch(FORBIDDEN_NOTICE);
  });

  it("late tick with idle ELU, low CPU and high run-delay is cpu-contention", () => {
    const sample = classifyHostLag({
      wallLagMs: 6079,
      hrLagMs: 6060,
      eluActiveMs: 40,
      eluIdleMs: 11000,
      cpuMs: 30,
      loadavg1: 18,
      cpuCount: 24,
      runDelayMs: 5800,
    });
    expect(sample.cause).toBe("cpu-contention");
    expect(shouldNotifyHostLag(sample)).toBe(true);
    expect(localizeHostLagNotice(l10n, sample.cause, sample.wallLagMs)).toMatch(/waited 6079ms for CPU/);
    expect(localizeHostLagNotice(l10n, sample.cause, sample.wallLagMs)).not.toMatch(FORBIDDEN_NOTICE);
  });

  it("wall clock jump without monotonic lag is clock-jump and does not notify", () => {
    const sample = classifyHostLag({
      wallLagMs: 6079,
      hrLagMs: 12,
      eluActiveMs: 8,
      eluIdleMs: 5000,
      cpuMs: 6,
      loadavg1: 2.2,
      cpuCount: 24,
      runDelayMs: 0,
    });
    expect(sample.cause).toBe("clock-jump");
    expect(shouldNotifyHostLag(sample)).toBe(false);
  });

  it("late tick with no busy thread, no run-delay and a quiet machine is unknown", () => {
    const sample = classifyHostLag({
      wallLagMs: 6079,
      hrLagMs: 6060,
      eluActiveMs: 20,
      eluIdleMs: 11000,
      cpuMs: 15,
      loadavg1: 2.2,
      cpuCount: 24,
      runDelayMs: 3,
    });
    expect(sample.cause).toBe("unknown");
    expect(shouldNotifyHostLag(sample)).toBe(true);
    expect(localizeHostLagNotice(l10n, sample.cause, sample.wallLagMs)).toMatch(/late by 6079ms/);
    expect(localizeHostLagNotice(l10n, sample.cause, sample.wallLagMs)).not.toMatch(FORBIDDEN_NOTICE);
  });

  it("log line names the cause and the numbers, not a Bridge recovery", () => {
    const sample = classifyHostLag({
      wallLagMs: 6079,
      hrLagMs: 6060,
      eluActiveMs: 40,
      eluIdleMs: 11000,
      cpuMs: 30,
      loadavg1: 18,
      cpuCount: 24,
      runDelayMs: 5800,
    });
    const line = formatHostLagLog(sample);
    expect(line).toContain("cause=cpu-contention");
    expect(line).toContain("lagMs=6079");
    expect(line).not.toMatch(FORBIDDEN_NOTICE);
  });

  it("fails if the live notice again suggests Bridge recovery (t-0bf709 red proof)", () => {
    const sources = [
      EXT,
      BUNDLE,
      path.resolve(__dirname, "../../apps/vscode-extension/src/workspace/hostEventLoopLag.ts"),
    ];
    const hits: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      if (FORBIDDEN_SOURCE.test(text)) hits.push(path.relative(process.cwd(), file));
    }
    expect(hits).toEqual([]);
  });
});
