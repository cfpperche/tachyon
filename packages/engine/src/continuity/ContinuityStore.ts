import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A saved agent's plain Markdown working memory. */
export class ContinuityStore {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "continuity");
  }

  pathOf(agent: string): string {
    return path.join(this.dir, `${agent}.md`);
  }

  exists(agent: string): boolean {
    return fs.existsSync(this.pathOf(agent));
  }

  read(agent: string): string | null {
    try {
      return fs.readFileSync(this.pathOf(agent), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  write(agent: string, content: string): { path: string; bytes: number } {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.pathOf(agent);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, target);
    return { path: target, bytes: Buffer.byteLength(content, "utf8") };
  }

  remove(agent: string): void {
    try {
      fs.rmSync(this.pathOf(agent), { force: true });
    } catch {
      /* best-effort */
    }
  }
}
