import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readCatalog = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(process.cwd(), file), "utf8")) as Record<string, string>;

const assertTranslation = (source: string, translated: Record<string, string>) => {
  expect(translated[source]).toMatch(source.includes("{0}") ? /^(?=.+\S).+\{0\}/ : /^(?=.+\S).+$/);
};

describe("container-generated delegation behavior", () => {
  it("i18n completeness", () => {
    const translatedBundle = readCatalog("apps/vscode-extension/l10n/bundle.l10n.pt-br.json");
    const translatedPackage = readCatalog("apps/vscode-extension/package.nls.pt-br.json");

    assertTranslation("Could not open config: {0}", translatedBundle);
    assertTranslation("Tachyon Doctor found problems — see the Output panel", translatedBundle);
    assertTranslation("Tachyon Doctor report ready — see the Output panel", translatedBundle);
    assertTranslation("command.doctor", translatedPackage);
    assertTranslation("command.openConfig", translatedPackage);
  });
});
