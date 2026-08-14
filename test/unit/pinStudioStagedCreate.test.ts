import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mintPinId, PinStore } from "@tachyon/engine/pins/PinStore.js";
import { savePinStudio } from "@tachyon/engine/pins/pinStudioService.js";
import type { PinStudioPatchV1 } from "@tachyon/engine/runtime-api/pinStudioCommands.js";

const roots: string[] = [];
const patch: PinStudioPatchV1 = {
  title: "Staged pin",
  tags: [],
  doc: { type: "doc", content: [] },
  attachments: [],
  docDirty: false,
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("t-c021fe — staged Pin document creation", () => {
  it("persists the pre-minted identity on first save and creates no second entity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pin-staged-"));
    roots.push(root);
    const store = new PinStore(root);
    const id = mintPinId();

    expect(store.list()).toEqual([]);
    expect(await savePinStudio(store, id, patch)).toEqual({ status: "ok", pinId: id });
    expect(store.list().map((pin) => pin.id)).toEqual([id]);
  });
});
