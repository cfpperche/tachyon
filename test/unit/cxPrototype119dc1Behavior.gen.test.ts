import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskPrototypeStore } from "@tachyon/engine/tasks/TaskPrototypeStore.js";
import { assembleUntrustedSrcdoc } from "@tachyon/shared/webview/shared/untrustedSrcdoc.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("container-generated delegation behavior", () => {
  it("an agent-authored task prototype is stored as an untrusted draft and only first-party approval can select its immutable anchor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-prototype-behavior-"));
    dirs.push(root);
    const store = new TaskPrototypeStore(root, "t-119dc1");
    const html = `<main><button>Choose layout</button><script>document.querySelector('button').onclick=()=>document.body.dataset.clicked='yes'</script></main>`;
    const created = store.createDraft({ html, title: "Navigation proposal", author: "ui-agent", now: "2026-07-09T00:00:00.000Z" });
    const draft = created.prototypes[0]!;

    expect(draft).toMatchObject({ state: "draft", author: "ui-agent", available: true, integrity: "verified" });
    expect(store.readHtml(draft.id)).toBe(html);
    const staticDocument = assembleUntrustedSrcdoc(store.readHtml(draft.id), { mode: "prototype-static" });
    expect(staticDocument).toContain("script-src 'none'");
    expect(staticDocument).not.toContain("onclick=()=>");

    const approved = store.approve(draft.id, { expectUpdatedAt: created.updatedAt!, now: "2026-07-09T00:01:00.000Z" });
    expect(approved.approved).toMatchObject({ id: draft.id, sha256: draft.sha256, state: "approved", approvedBy: "human" });
    expect(fs.readFileSync(store.prototypePath(draft.sha256), "utf8")).toBe(html);
    expect(() => store.approve(draft.id, { expectUpdatedAt: approved.updatedAt! })).toThrow(/invalid prototype transition/);
  });
});
