import { describe, it, expect } from "vitest";
import { parseLockfile, serializeLockfile, physicalDataKey, dataReferenceCounts, type Lockfile, type DataLock } from "@tachyon/engine/plugins/lockfile.js";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

function dataLock(over: Partial<DataLock> = {}): DataLock {
  return {
    name: "model", resolvedPlatform: "any", version: "base", contentSha256: SHA, fileName: "ggml-base.bin",
    installPath: `.tachyon/data/sha256/${SHA}/ggml-base.bin`, declaredUrl: "https://h/m.bin", finalUrl: "https://cdn/m.bin", ...over,
  };
}

function lf(plugins: Lockfile["plugins"]): Lockfile {
  return { schemaVersion: 1, plugins };
}

describe("DataLock — parse + serialize round-trip (spec 284)", () => {
  it("round-trips a plugin with a data artifact", () => {
    const original = lf({ tr: { name: "tr", version: "1.0.0", runtimes: ["claude"], targets: [], data: [dataLock()] } });
    const { lockfile, errors } = parseLockfile(serializeLockfile(original));
    expect(errors).toEqual([]);
    expect(lockfile?.plugins.tr.data?.[0]).toEqual(dataLock());
  });

  it("accepts a per-platform resolvedPlatform key", () => {
    const original = lf({ tr: { name: "tr", version: "1.0.0", runtimes: ["claude"], targets: [], data: [dataLock({ resolvedPlatform: "linux-x64-glibc" })] } });
    const { lockfile, errors } = parseLockfile(serializeLockfile(original));
    expect(errors).toEqual([]);
    expect(lockfile?.plugins.tr.data?.[0].resolvedPlatform).toBe("linux-x64-glibc");
  });

  it("fails closed on a bad sha256 / bad platform / non-https url", () => {
    const bad = parseLockfile(JSON.stringify(lf({ tr: { name: "tr", version: "1.0.0", runtimes: ["claude"], targets: [], data: [{ ...dataLock(), contentSha256: "nope", resolvedPlatform: "windows", declaredUrl: "http://x/m" }] } })));
    expect(bad.lockfile).toBeUndefined();
    expect(bad.errors.some((e) => /contentSha256/.test(e))).toBe(true);
    expect(bad.errors.some((e) => /resolvedPlatform/.test(e))).toBe(true);
    expect(bad.errors.some((e) => /declaredUrl/.test(e))).toBe(true);
  });
});

describe("dataReferenceCounts (spec 284)", () => {
  it("counts a shared blob across plugins by physical identity", () => {
    const shared = dataLock(); // same installPath + sha
    const lock = lf({
      a: { name: "a", version: "1.0.0", runtimes: ["claude"], targets: [], data: [shared] },
      b: { name: "b", version: "1.0.0", runtimes: ["claude"], targets: [], data: [shared] },
      c: { name: "c", version: "1.0.0", runtimes: ["claude"], targets: [], data: [dataLock({ contentSha256: SHA2, installPath: `.tachyon/data/sha256/${SHA2}/other.bin` })] },
    });
    const refs = dataReferenceCounts(lock);
    expect(refs.get(physicalDataKey(shared))).toEqual(new Set(["a", "b"]));
    expect(refs.size).toBe(2);
  });
});
