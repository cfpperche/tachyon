import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentLaunchPath, nvmBinDir, userCliDirs } from "@tachyon/engine/agents/spawnPath.js";

describe("spawnPath — agent session PATH (rebind exit-127 fix)", () => {
  it("userCliDirs only returns existing dirs under home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-spawn-path-"));
    try {
      fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      fs.mkdirSync(path.join(home, ".cargo", "bin"), { recursive: true });
      const dirs = userCliDirs(home);
      expect(dirs).toContain(path.join(home, ".local", "bin"));
      expect(dirs).toContain(path.join(home, ".cargo", "bin"));
      expect(dirs).not.toContain(path.join(home, ".bun", "bin"));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("nvmBinDir prefers NVM_BIN when it exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-spawn-path-"));
    try {
      const bin = path.join(home, "nvm-bin");
      fs.mkdirSync(bin);
      expect(nvmBinDir({ NVM_BIN: bin }, home)).toBe(bin);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("nvmBinDir picks the newest versions/node/*/bin that has node", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-spawn-path-"));
    try {
      const v22 = path.join(home, ".nvm", "versions", "node", "v22.0.0", "bin");
      const v24 = path.join(home, ".nvm", "versions", "node", "v24.11.1", "bin");
      fs.mkdirSync(v22, { recursive: true });
      fs.mkdirSync(v24, { recursive: true });
      fs.writeFileSync(path.join(v22, "node"), "");
      fs.writeFileSync(path.join(v24, "node"), "");
      expect(nvmBinDir({ NVM_DIR: path.join(home, ".nvm") }, home)).toBe(v24);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("agentLaunchPath prepends nvm + user CLI dirs missing from a stripped PATH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-spawn-path-"));
    try {
      const nvmBin = path.join(home, ".nvm", "versions", "node", "v24.11.1", "bin");
      const localBin = path.join(home, ".local", "bin");
      fs.mkdirSync(nvmBin, { recursive: true });
      fs.mkdirSync(localBin, { recursive: true });
      fs.writeFileSync(path.join(nvmBin, "node"), "");
      const result = agentLaunchPath({ PATH: "/usr/bin:/bin", NVM_DIR: path.join(home, ".nvm") }, home);
      const parts = result.split(path.delimiter);
      expect(parts[0]).toBe(nvmBin);
      expect(parts).toContain(localBin);
      expect(parts.slice(-2)).toEqual(["/usr/bin", "/bin"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("agentLaunchPath does not duplicate dirs already on PATH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-spawn-path-"));
    try {
      const nvmBin = path.join(home, ".nvm", "versions", "node", "v24.11.1", "bin");
      fs.mkdirSync(nvmBin, { recursive: true });
      fs.writeFileSync(path.join(nvmBin, "node"), "");
      const base = `${nvmBin}${path.delimiter}/usr/bin`;
      const result = agentLaunchPath({ PATH: base, NVM_DIR: path.join(home, ".nvm") }, home);
      expect(result.split(path.delimiter).filter((p) => p === nvmBin)).toHaveLength(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
