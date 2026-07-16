import path from "node:path";

const OWNS_FAKE_ROOT = "/__tachyon_owns_root__";

function resolveOwnsPath(value: string): string | undefined {
  const normalized = path.posix.normalize(`${OWNS_FAKE_ROOT}/${value.replace(/\\/g, "/")}`);
  if (normalized !== OWNS_FAKE_ROOT && !normalized.startsWith(`${OWNS_FAKE_ROOT}/`)) return undefined;
  return normalized.slice(OWNS_FAKE_ROOT.length + 1).replace(/\/+$/, "");
}

/** True when every requested path is equal to or nested under an immutable Delivery-owned path. */
export function isOwnsSubset(requested: string[], original: string[]): boolean {
  const originalNormalized = original.map(resolveOwnsPath).filter((value): value is string => value !== undefined);
  return requested.every((value) => {
    const normalized = resolveOwnsPath(value);
    if (normalized === undefined) return false;
    return originalNormalized.some((owned) => normalized === owned || normalized.startsWith(`${owned}/`));
  });
}
