import { lstat, mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentSoulPath, importSoulProfile, readCanonicalSoulBytes, resolveSoul, resolveSoulWithRetry, soulLaunchReservationsDir, SoulError, SOUL_MAX_BYTES } from "../../src/agents/soul.js";

const fsFault = vi.hoisted(() => ({ manifestCode: undefined as string | undefined, manifestError: undefined as unknown }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (fsFault.manifestError && path.basename(String(args[0])) === "profile.json") throw fsFault.manifestError;
      if (fsFault.manifestCode && path.basename(String(args[0])) === "profile.json") {
        throw Object.assign(new Error("injected manifest read failure"), { code: fsFault.manifestCode });
      }
      return actual.open(...args);
    },
  };
});

async function profile(body: Buffer | string, state: "active" | "retained" = "active") {
  const root = await mkdtemp(path.join(tmpdir(), "tachyon-soul-"));
  const dir = path.join(root, ".tachyon", "agents", "Ada");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SOUL.md"), body);
  await writeFile(path.join(dir, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "Ada", state }), { mode: 0o600 });
  return root;
}

async function codeOf(promise: Promise<unknown>) {
  try { await promise; } catch (error) { return error as SoulError; }
  throw new Error("expected rejection");
}

describe("strict soul profile resolver", () => {
  it("preserves exact CRLF bytes and raw digest", async () => {
    const bytes = Buffer.from("Voice\r\nValues\r\n");
    const resolved = await resolveSoul(await profile(bytes), "Ada");
    expect(resolved.body).toBe(bytes.toString());
    expect(resolved.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(resolved.source).toBe(".tachyon/agents/Ada/SOUL.md");
  });

  it.each([
    [Buffer.from([0xff]), "soul/invalid-utf8"],
    [" \n\t", "soul/empty"],
    ["a\0b", "soul/invalid-utf8"],
    ["a".repeat(20_001), "soul/too-many-chars"],
    ["x".repeat(SOUL_MAX_BYTES + 1), "soul/too-many-bytes"],
  ])("rejects invalid content without retry: %s", async (body, expected) => {
    const error = await codeOf(resolveSoul(await profile(body), "Ada"));
    expect(error.code).toBe(expected);
    expect(error.retryable).toBe(false);
  });

  it("counts Unicode scalar values, not UTF-16 code units", async () => {
    const resolved = await resolveSoul(await profile("😀".repeat(10_000)), "Ada");
    expect(resolved.chars).toBe(10_000);
  });

  it("rejects retained manifests and final symlinks", async () => {
    expect((await codeOf(resolveSoul(await profile("valid", "retained"), "Ada"))).code).toBe("soul/profile-adoption-required");
    const root = await profile("valid");
    const target = path.join(root, "target.md");
    await writeFile(target, "other");
    await writeFile(agentSoulPath(root, "Ada"), "old");
    const soul = agentSoulPath(root, "Ada");
    const { rm } = await import("node:fs/promises");
    await rm(soul);
    await symlink(target, soul);
    expect((await codeOf(resolveSoul(root, "Ada"))).code).toBe("soul/final-symlink");
  });

  it.each([
    ["EIO", "soul/io-error", true],
    ["EBUSY", "soul/io-error", true],
    ["EMFILE", "soul/io-error", true],
    ["ENFILE", "soul/io-error", true],
    ["EACCES", "soul/permission-denied", false],
    ["EPERM", "soul/permission-denied", false],
    ["ENOENT", "soul/profile-adoption-required", false],
    ["ENOSPC", "soul/io-error", false],
  ])("classifies manifest read failure %s as %s", async (fsCode, soulCode, retryable) => {
    const root = await profile("valid");
    fsFault.manifestCode = fsCode;
    try {
      await expect(resolveSoul(root, "Ada")).rejects.toMatchObject({ code: soulCode, retryable });
    } finally {
      fsFault.manifestCode = undefined;
    }
  });

  it("preserves a retryable SoulError raised while opening the private manifest", async () => {
    const root = await profile("valid");
    const injected = new SoulError("soul/source-changed-during-read", "manifest changed while opening", { retryable: true });
    fsFault.manifestError = injected;
    try {
      await expect(resolveSoul(root, "Ada")).rejects.toBe(injected);
      expect(injected.retryable).toBe(true);
    } finally {
      fsFault.manifestError = undefined;
    }
  });

  it("imports an exact private canonical copy and forgets the source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-import-root-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "tachyon-import-source-"));
    const source = path.join(sourceRoot, "identity.md");
    const bytes = Buffer.from("One\r\nTwo\n");
    await writeFile(source, bytes);
    const result = await importSoulProfile(root, "Ada", source);
    await writeFile(source, "changed");
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(bytes);
    expect(JSON.stringify(result)).not.toContain(source);
    expect((await resolveSoul(root, "Ada")).sha256).toBe(result.sha256);
    if (process.platform !== "win32") {
      expect((await lstat(agentSoulPath(root, "Ada"))).mode & 0o077).toBe(0);
      expect((await lstat(path.join(root, ".tachyon", "agents", "Ada", "profile.json"))).mode & 0o077).toBe(0);
    }
    await expect(importSoulProfile(root, "Ada", source)).rejects.toMatchObject({ code: "soul/profile-adoption-required" });
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(bytes);
  });

  it("publishes concurrently without clobbering the winning complete profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-import-race-root-"));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "tachyon-import-race-source-"));
    const sources = [path.join(sourceRoot, "one.md"), path.join(sourceRoot, "two.md")];
    const bodies = [Buffer.from("First complete identity\n"), Buffer.from("Second complete identity\n")];
    await Promise.all(sources.map((source, i) => writeFile(source, bodies[i])));

    const settled = await Promise.allSettled(sources.map((source) => importSoulProfile(root, "Ada", source)));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "soul/profile-adoption-required" });
    const canonical = await readFile(agentSoulPath(root, "Ada"));
    expect(bodies.some((body) => body.equals(canonical))).toBe(true);
    await expect(resolveSoul(root, "Ada")).resolves.toMatchObject({ body: expect.stringMatching(/^First|^Second/) });
  });

  it("serializes import with an active metadata-only lifecycle reservation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-import-reserved-root-"));
    const source = path.join(root, "identity.md");
    await writeFile(source, "Reserved identity");
    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const reservation = path.join(reservations, "ada--execution--123e4567-e89b-42d3-a456-426614174000.json");
    const metadata = { principal: "Ada", execution: "execution", profileId: "123e4567-e89b-42d3-a456-426614174000", sha256: "a".repeat(64) };
    await writeFile(reservation, JSON.stringify(metadata), { mode: 0o600, flag: "wx" });

    await expect(importSoulProfile(root, "Ada", source)).rejects.toMatchObject({ code: "soul/io-error" });
    expect(await readFile(reservation, "utf8")).not.toContain("Reserved identity");
    expect(await readFile(reservation, "utf8")).not.toContain(source);
    await unlink(reservation);
    await expect(importSoulProfile(root, "Ada", source)).resolves.toMatchObject({ profileId: expect.any(String) });
  });

  it("retries only transient soul failures at exactly 2s/4s/8s", async () => {
    const transient = () => new SoulError("soul/io-error", "transient", { retryable: true });
    const waits: number[] = [];
    let attempts = 0;
    await expect(resolveSoulWithRetry(async () => {
      if (++attempts < 3) throw transient();
      return "ok";
    }, async (ms) => { waits.push(ms); })).resolves.toBe("ok");
    expect(waits).toEqual([2_000, 4_000]);

    waits.length = 0;
    attempts = 0;
    await expect(resolveSoulWithRetry(async () => { attempts++; throw transient(); }, async (ms) => { waits.push(ms); })).rejects.toMatchObject({ retryable: true });
    expect(attempts).toBe(4);
    expect(waits).toEqual([2_000, 4_000, 8_000]);

    for (const deterministic of [
      new SoulError("soul/missing", "missing"),
      new SoulError("soul/too-many-bytes", `more than ${SOUL_MAX_BYTES}`),
    ]) {
      waits.length = 0;
      await expect(resolveSoulWithRetry(async () => { throw deterministic; }, async (ms) => { waits.push(ms); })).rejects.toBe(deterministic);
      expect(waits).toEqual([]);
    }
  });

  it("refuses a symlinked canonical parent before creating an out-of-workspace profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-import-parent-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "tachyon-import-parent-outside-"));
    const source = path.join(root, "identity.md");
    await writeFile(source, "identity");
    await mkdir(path.join(root, ".tachyon"));
    await symlink(outside, path.join(root, ".tachyon", "agents"));
    await expect(importSoulProfile(root, "Ada", source)).rejects.toMatchObject({ code: "soul/outside-workspace" });
    await expect(lstat(path.join(outside, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses parent and final symlinks on canonical status/open reads", async () => {
    const finalRoot = await profile("valid");
    const outsideFile = path.join(finalRoot, "outside.md");
    await writeFile(outsideFile, "outside");
    await unlink(agentSoulPath(finalRoot, "Ada"));
    await symlink(outsideFile, agentSoulPath(finalRoot, "Ada"));
    await expect(readCanonicalSoulBytes(finalRoot, "Ada")).rejects.toMatchObject({ code: "soul/final-symlink" });

    const parentRoot = await mkdtemp(path.join(tmpdir(), "tachyon-soul-read-parent-"));
    const outside = await profile("outside");
    await mkdir(path.join(parentRoot, ".tachyon"), { recursive: true });
    await symlink(path.join(outside, ".tachyon", "agents"), path.join(parentRoot, ".tachyon", "agents"));
    await expect(readCanonicalSoulBytes(parentRoot, "Ada")).rejects.toMatchObject({ code: "soul/outside-workspace" });
  });
});
