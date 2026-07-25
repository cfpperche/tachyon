import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(__dirname, "../../scripts/record-provenance.mjs");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function sha256Bytes(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-prov-audit-"));
  temps.push(root);
  return root;
}

/**
 * Build a minimal .vsix (zip). Production audit reads via `unzip -p`; Python's zipfile is the
 * local writer when the `zip` CLI is absent (common on minimal agents).
 */
function writeZip(vsixPath: string, entries: Record<string, string | Buffer>): void {
  const stage = path.join(path.dirname(vsixPath), `.vsix-stage-${path.basename(vsixPath)}`);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const [entryPath, body] of Object.entries(entries)) {
    const abs = path.join(stage, entryPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  // Build zip from staged tree so entry names match (extension/...).
  execFileSync(
    "python3",
    [
      "-c",
      "import os,sys,zipfile\n"
      + "root,out=sys.argv[1],sys.argv[2]\n"
      + "with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n"
      + "  for dp,_,fs in os.walk(root):\n"
      + "    for f in fs:\n"
      + "      p=os.path.join(dp,f); z.write(p, os.path.relpath(p, root))\n",
      stage,
      vsixPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  fs.rmSync(stage, { recursive: true, force: true });
}

/** t-1f425c — the vsix must actually CONTAIN the files its embedded record claims. `audit` now unpacks
 *  the artifact and refuses to write a record when the two disagree, so a fixture that claims files it
 *  does not pack is no longer a valid stand-in for a release candidate — it is the exact shape the
 *  check exists to reject. `payload` is those claimed files, keyed by their in-archive path. */
function writeFakeVsix(root: string, name: string, provenance: object, payload: Record<string, string> = {}): string {
  const vsixPath = path.join(root, name);
  writeZip(vsixPath, {
    "extension/provenance.json": `${JSON.stringify(provenance, null, 2)}\n`,
    ...payload,
  });
  return vsixPath;
}

describe("record-provenance audit (t-86b1fa)", () => {
  it("derives engineChannel and dist from the VSIX even when workspace dist is already dev", () => {
    const root = makeTempRoot();
    const version = "0.0.0-audit-test";
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "tachyon", version }, null, 2),
    );

    // Workspace dist is the post-verify:full shape: default channel is `dev`, different bytes.
    const workspaceDistJs = "workspace-dev-build";
    fs.mkdirSync(path.join(root, "dist", "engine"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "extension.js"), workspaceDistJs);
    fs.writeFileSync(
      path.join(root, "dist", "engine", "engine-manifest.json"),
      JSON.stringify({ schemaVersion: 1, channel: "dev", engineVersion: version }),
    );

    const packagedDistJs = "packaged-stable-build";
    const packagedManifest = JSON.stringify({ schemaVersion: 1, channel: "stable", engineVersion: version });
    const packagedDist = {
      "dist/extension.js": sha256Bytes(packagedDistJs),
      "dist/engine/engine-manifest.json": sha256Bytes(packagedManifest),
    };
    const packaged = {
      version,
      engineChannel: "stable" as const,
      commit: "packaged-commit",
      treeSha: "packaged-tree",
      workingTreeClean: true,
      dist: packagedDist,
    };
    const vsixName = `tachyon-${version}.vsix`;
    writeFakeVsix(root, vsixName, packaged, {
      "extension/dist/extension.js": packagedDistJs,
      "extension/dist/engine/engine-manifest.json": packagedManifest,
    });

    execFileSync(process.execPath, [scriptPath, "audit", vsixName], {
      cwd: root,
      env: {
        ...process.env,
        TACHYON_SKIP_PROVENANCE_VERIFY: "1",
        TACHYON_AGENT_NAME: "test-auditor",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const auditPath = path.join(root, ".tachyon", "deploys", `${version}.json`);
    expect(fs.existsSync(auditPath)).toBe(true);
    const audit = JSON.parse(fs.readFileSync(auditPath, "utf8")) as {
      version: string;
      engineChannel: string;
      commit: string;
      treeSha: string;
      workingTreeClean: boolean;
      dist: Record<string, string>;
      vsix: { path: string; sha256: string };
      packagedBy: string;
      verify: { result: string };
    };

    expect(audit.version).toBe(version);
    expect(audit.engineChannel).toBe("stable");
    expect(audit.commit).toBe("packaged-commit");
    expect(audit.treeSha).toBe("packaged-tree");
    expect(audit.workingTreeClean).toBe(true);
    expect(audit.dist).toEqual(packagedDist);
    // Must NOT pick up the workspace-dev dist hash.
    expect(audit.dist["dist/extension.js"]).not.toBe(sha256Bytes(workspaceDistJs));
    expect(audit.vsix.path).toBe(vsixName);
    expect(audit.vsix.sha256).toBe(sha256Bytes(fs.readFileSync(path.join(root, vsixName))));
    expect(audit.packagedBy).toBe("test-auditor");
    expect(audit.verify.result).toContain("skipped");
  });

  it("falls back to a pre-verify workspace snapshot when the VSIX has no embedded provenance", () => {
    const root = makeTempRoot();
    const version = "0.0.0-audit-fallback";
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "tachyon", version }, null, 2),
    );

    const stableJs = "pre-verify-stable";
    fs.mkdirSync(path.join(root, "dist", "engine"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "extension.js"), stableJs);
    fs.writeFileSync(
      path.join(root, "dist", "engine", "engine-manifest.json"),
      JSON.stringify({ schemaVersion: 1, channel: "stable", engineVersion: version }),
    );

    // Zip without provenance.json → forces workspace-pre-verify path.
    const vsixName = `tachyon-${version}.vsix`;
    writeZip(path.join(root, vsixName), {
      "extension/readme.txt": "no provenance",
    });

    execFileSync(process.execPath, [scriptPath, "audit", vsixName], {
      cwd: root,
      env: {
        ...process.env,
        TACHYON_SKIP_PROVENANCE_VERIFY: "1",
        TACHYON_AGENT_NAME: "test-auditor",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const audit = JSON.parse(
      fs.readFileSync(path.join(root, ".tachyon", "deploys", `${version}.json`), "utf8"),
    ) as { engineChannel: string; dist: Record<string, string> };

    expect(audit.engineChannel).toBe("stable");
    expect(audit.dist["dist/extension.js"]).toBe(sha256Bytes(stableJs));
  });
});
