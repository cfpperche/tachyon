import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "../../src/webview/formLogic";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Computed (non-literal) specifier: the plain tsconfig used for test/unit/*.ts has no --jsx, so a
// static `import` of this .tsx would fail tsc; a runtime-computed path is untyped (`any`) to tsc but
// still resolves for real under vitest, letting this test exercise the actual resolver + components.
const runtimeLogosPath = ["..", "..", "src/webview/agent-studio-shell/runtimeLogos"].join("/");

describe("container-generated delegation behavior", () => {
  it("every quick-add runtime logo id resolves to a valid inline renderer with no corrupt base64", async () => {
    const { RuntimeLogo, PNG_LOGOS } = (await import(runtimeLogosPath)) as any;

    for (const entry of AGENT_CATALOG) {
      const rendered = RuntimeLogo({ id: entry.bin });
      expect(rendered, `RuntimeLogo did not resolve a renderer for "${entry.bin}"`).not.toBeNull();
    }

    const pngEntries = Object.entries(PNG_LOGOS as Record<string, string>);
    expect(pngEntries.length).toBeGreaterThan(0);
    for (const [id, dataUri] of pngEntries) {
      const match = /^data:image\/png;base64,(.+)$/.exec(dataUri);
      expect(match, `"${id}" is not a data:image/png;base64 URI`).not.toBeNull();
      const bytes = Buffer.from(match![1], "base64");
      expect(
        bytes.subarray(0, 8).equals(PNG_SIGNATURE),
        `"${id}" base64 does not decode to a valid PNG (bad signature/padding)`,
      ).toBe(true);
    }
  });
});
