import fs from "node:fs";

/**
 * Cumulative CPU ticks (utime+stime) of a process plus one level of children —
 * enough to see through a `sh -c` wrapper to the agent doing the work. Linux-only
 * (/proc); returns null elsewhere, in which case pane stability alone drives the
 * idle signal (documented degradation for macOS).
 */
export function subtreeCpuTicks(pid: number): number | null {
  const own = statTicks(pid);
  if (own === null) return null;
  let total = own;
  for (const child of childrenOf(pid)) {
    total += statTicks(child) ?? 0;
  }
  return total;
}

function statTicks(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces/parens — fields start after the closing paren.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const utime = Number.parseInt(after[11], 10); // field 14 overall
    const stime = Number.parseInt(after[12], 10); // field 15 overall
    if (Number.isNaN(utime) || Number.isNaN(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}

function childrenOf(pid: number): number[] {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}
