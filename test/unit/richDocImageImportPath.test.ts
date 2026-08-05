import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const studios = ["pin-studio", "task-studio"] as const;

describe("rich-doc image Import shares the paste/drop content path (t-cdab51)", () => {
  for (const studio of studios) {
    it(`${studio}: every Import trigger opens KitFilePicker and selected files call attachFile`, () => {
      const app = readFileSync(`src/webview/${studio}/App.tsx`, "utf8");
      const messages = readFileSync(`src/webview/${studio}/messages.ts`, "utf8");
      const types = readFileSync(`src/webview/${studio}/types.ts`, "utf8");
      const domain = readFileSync(`src/cockpit/${studio === "pin-studio" ? "pinStudioDomain" : "taskStudioDomain"}.ts`, "utf8");

      expect(app).toContain("<ImageImportPicker");
      expect(app).toContain('await attachFile(file, "import")');
      expect(app).toMatch(/const attachFile = async[\s\S]*post\(attachImageMessage/);
      expect(app.match(/onImport=\{\(\) => setImagePickerOpen\(true\)\}/g)).toHaveLength(1);
      expect(app).not.toContain("importImageMessage");
      expect(messages).not.toContain("importImageMessage");
      expect(types).not.toContain('type: "importImage"');
      expect(domain).not.toContain('message.type === "importImage"');
      expect(domain).not.toContain(`Import image into ${studio === "pin-studio" ? "pin" : "task"}`);
      expect(domain).not.toContain('filters: { Images:');
    });
  }

  it("the shared picker delegates file selection to KitFilePicker instead of creating another input", () => {
    const picker = readFileSync("src/webview/rich-doc/ImageImportPicker.tsx", "utf8");
    expect(picker).toContain("<KitFilePicker");
    expect(picker).not.toContain('type="file"');
  });
});
