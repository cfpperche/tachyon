const { readFileSync } = require("node:fs");

/** Parse Linux /proc/meminfo kB fields into MiB. */
function parseMeminfo(text) {
  const get = (key) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
    if (!match) return undefined;
    return Math.floor(Number(match[1]) / 1024);
  };
  const memTotalMb = get("MemTotal");
  const memAvailableMb = get("MemAvailable") ?? get("MemFree");
  if (memTotalMb === undefined || memAvailableMb === undefined) return undefined;
  return {
    memTotalMb,
    memAvailableMb,
    swapTotalMb: get("SwapTotal") ?? 0,
    swapFreeMb: get("SwapFree") ?? 0,
    source: "proc-meminfo",
  };
}

function readHostMemory(readFile = (path) => readFileSync(path, "utf8"), path = "/proc/meminfo") {
  try {
    const parsed = parseMeminfo(readFile(path));
    if (parsed) return parsed;
  } catch {
    /* fall through */
  }
  return { memTotalMb: 0, memAvailableMb: 0, swapTotalMb: 0, swapFreeMb: 0, source: "unavailable" };
}

module.exports = { parseMeminfo, readHostMemory };
