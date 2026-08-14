import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeStatusLineCaptureTransport } from "@tachyon/engine/runtimeObservability/claudeStatusLineCapture.js";
import { ClaudeStatusLineObservationSource } from "@tachyon/engine/runtimeObservability/claudeStatusLineSource.js";
import { CodexAppServerObservationSource } from "@tachyon/engine/runtimeObservability/codexAppServerSource.js";
import {
  ProviderObservationPreferences,
  type ProviderObservationStatePort,
} from "@tachyon/engine/runtimeObservability/preferences.js";
import { ProviderObservationService } from "@tachyon/engine/runtimeObservability/service.js";
import type { CollectorEnvelopeV1, RuntimeObservabilityProviderV1 } from "@tachyon/engine/runtimeObservability/types.js";
import { validateCollectorEnvelopeV1 } from "@tachyon/engine/runtimeObservability/validate.js";

class MemoryState implements ProviderObservationStatePort {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
}

function summary(provider: RuntimeObservabilityProviderV1, envelope: CollectorEnvelopeV1): Record<string, unknown> {
  const fact = envelope.facts[0];
  return {
    provider,
    kind: fact?.kind ?? "missing",
    ...(fact?.kind === "provider-quota" ? { source: fact.source, windows: fact.windows.length } : {}),
    ...(fact?.kind === "provider-unavailable" ? { reason: fact.reason, source: fact.source } : {}),
    diagnostics: envelope.diagnostics.length,
  };
}

function findCapture(root: string): string | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.name.endsWith(".capture.json")) return file;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-observability-dogfood-"));
  const storage = path.join(root, "global-storage");
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  fs.mkdirSync(storage, { mode: 0o700 });
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const state = new MemoryState();
  const preferences = new ProviderObservationPreferences(state);
  const capture = new ClaudeStatusLineCaptureTransport(storage, preferences, {
    homeDir: home,
    managedSettingsPaths: [],
  });
  const service = new ProviderObservationService(
    preferences,
    [
      new CodexAppServerObservationSource(),
      new ClaudeStatusLineObservationSource({ readCapture: capture.readCapture }),
    ],
    {
      state,
      collectionTimeoutMs: 12_000,
      onPreferenceChanged: (provider) => capture.clearProvider(provider),
    },
  );

  try {
    await service.configureProvider("codex", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    });
    const codexFirst = service.refresh("codex");
    const codexCoalesced = service.refresh("codex");
    if (codexFirst !== codexCoalesced) throw new Error("Codex collection did not coalesce");
    const codex = await codexFirst;
    if (!validateCollectorEnvelopeV1(codex).ok) throw new Error("Codex envelope failed validation");

    await service.configureProvider("claude", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    });
    const setting = capture.materialize({
      workspaceRoot: workspace,
      agent: "dogfood-claude",
      cwd: workspace,
    });
    if (!setting) throw new Error("Claude capture setting was not materialized");
    const marker = "RAW_STATUS_LINE_MUST_NOT_PERSIST";
    const wrapper = spawnSync("/bin/sh", ["-c", setting.command], {
      cwd: workspace,
      input: JSON.stringify({
        session_id: marker,
        cwd: `/private/${marker}`,
        rate_limits: {
          five_hour: { used_percentage: 1 },
          seven_day: { used_percentage: 2 },
        },
      }),
      encoding: "utf8",
      timeout: 5_000,
    });
    if (wrapper.status !== 0 || wrapper.stdout !== "" || wrapper.stderr !== "") {
      throw new Error(
        `Claude status-line wrapper contract failed (status=${String(wrapper.status)}, signal=${String(wrapper.signal)}, stdoutBytes=${Buffer.byteLength(wrapper.stdout ?? "")}, stderrBytes=${Buffer.byteLength(wrapper.stderr ?? "")})`,
      );
    }
    const captureFile = findCapture(storage);
    if (!captureFile) throw new Error("Claude reduced capture was not written");
    if (fs.readFileSync(captureFile, "utf8").includes(marker)) {
      throw new Error("Claude raw status-line data crossed the disk boundary");
    }
    const claude = await service.refresh("claude");
    if (!validateCollectorEnvelopeV1(claude).ok || claude.facts[0]?.kind !== "provider-quota") {
      throw new Error("Claude passive capture did not produce a validated quota fact");
    }

    console.log(JSON.stringify({
      schemaVersion: 1,
      coalesced: true,
      observations: [summary("codex", codex), summary("claude", claude)],
      rawCapturePersisted: false,
    }));
  } finally {
    service.dispose();
    capture.clearProvider("claude");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(`runtime-observability dogfood failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
