import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readCatalog = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, string>;

describe("container-generated delegation behavior", () => {
  it("i18n completeness", () => {
    const nls = readCatalog("apps/vscode-extension/package.nls.json");
    const source = readFileSync(join(process.cwd(), "apps/vscode-extension/src/extension.ts"), "utf8");

    expect(source).toContain('l10n.t("Could not open config: {0}"');
    expect(source).toContain("Tachyon Doctor found problems — see the Output panel");
    expect(source).toContain("Tachyon Doctor report ready — see the Output panel");
    expect(nls["command.doctor"]).toMatch(/\S/);
    expect(nls["command.openConfig"]).toMatch(/\S/);
  });
});
