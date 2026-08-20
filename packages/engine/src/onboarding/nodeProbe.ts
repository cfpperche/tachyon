/**
 * t-505f13 — the onboarding Node probe: the SAME door the engine boots through, wrapped for a
 * screen that wants the answer BEFORE the attach loop hits it.
 *
 * Why not a fresh `which node`: the extension host may itself be Electron, where a `node` on PATH
 * can be a shim (asdf, volta) that the engine's own `resolveEngineRuntimeSource` rejects on purpose
 * (`validatesAsNode` requires the candidate's `process.execPath` to match it). A check that accepts
 * what the engine refuses would name Node present and then watch the attach fail — the exact
 * silence this screen exists to remove.
 */

import { isElectronRuntime, resolveEngineRuntimeSource } from "../engine-service/engineBundleStore.js";
import type { NodeCheckResult } from "./environmentCheck.js";

export interface NodeProbeEnv {
  versions?: Readonly<Record<string, string | undefined>>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  sourceExecutable?: string;
}

export async function probeEngineNodeRuntime(probeEnv: NodeProbeEnv = {}): Promise<NodeCheckResult> {
  const versions = probeEnv.versions ?? process.versions;
  const sourceExecutable = probeEnv.sourceExecutable ?? process.execPath;
  if (!isElectronRuntime(versions)) {
    // The host itself is a real Node — the engine boots with this very executable.
    return { ok: true, source: sourceExecutable };
  }
  try {
    const resolved = await resolveEngineRuntimeSource({
      sourceExecutable,
      versions,
      ...(probeEnv.env ? { env: probeEnv.env } : {}),
      ...(probeEnv.platform ? { platform: probeEnv.platform } : {}),
    });
    return { ok: true, source: resolved };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
