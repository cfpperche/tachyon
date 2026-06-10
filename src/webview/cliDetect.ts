import { execFile } from "node:child_process";
import { KNOWN_AI_CLIS } from "../config/loadConfig.js";

/** Which known AI CLIs exist on this machine — drives the quick-add chips. */
export async function detectInstalledClis(
  probe: (bin: string) => Promise<boolean> = defaultProbe,
): Promise<string[]> {
  const checks = await Promise.all(KNOWN_AI_CLIS.map(async (bin) => ((await probe(bin)) ? bin : null)));
  return checks.filter((b): b is string => b !== null);
}

function defaultProbe(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [bin], (err) => resolve(!err));
  });
}
