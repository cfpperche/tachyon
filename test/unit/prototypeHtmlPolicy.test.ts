import { describe, expect, it } from "vitest";
import { PROTOTYPE_DATA_MAX_DECODED_BYTES, PROTOTYPE_HTML_MAX_BYTES, validatePrototypeHtml } from "../../src/tasks/prototypeHtmlPolicy.js";
import { assembleUntrustedSrcdoc } from "../../src/webview/shared/untrustedSrcdoc.js";

describe("prototypeHtmlPolicy", () => {
  it("accepts a bounded self-contained mock with inline CSS, script, and raster data", () => {
    const html = `<!doctype html><style>.x{background:url(data:image/png;base64,YQ==)}</style><button>Try</button><script>document.querySelector('button').textContent='Ready'</script>`;
    expect(validatePrototypeHtml(html)).toMatchObject({ byteSize: Buffer.byteLength(html), decodedDataBytes: 1, policyVersion: 1 });
  });

  it("does not mistake ordinary script identifiers for HTML URL attributes", () => {
    const html = `<script>
      const data = { ok: true };
      let href = location.hash;
      const action = () => 1;
      document.body.dataset.href = href;
    </script>`;
    expect(validatePrototypeHtml(html)).toMatchObject({ policyVersion: 1 });
  });

  it.each([
    ["external image", `<img src="https://example.test/x.png">`],
    ["encoded external URL", `<img src="https&#x3a;//example.test/x">`],
    ["form", `<form action="#"><button>submit</button></form>`],
    ["nested frame", `<iframe srcdoc="ok"></iframe>`],
    ["author CSP", `<meta http-equiv="Content-Security-Policy" content="default-src *">`],
    ["refresh", `<meta http-equiv="refresh" content="0;url=https://example.test">`],
    ["handler", `<button onclick="alert(1)">x</button>`],
    ["worker", `<script>new Worker('data:text/javascript,1')</script>`],
    ["external CSS", `<style>@import 'https://example.test/a.css'</style>`],
    ["external script", `<script src="data:text/javascript,alert(1)"></script>`],
    ["privileged URL", `<a href="javascript:alert(1)">x</a>`],
    ["script-looking external image attribute", `<img data="https://example.test/leak">`],
  ])("rejects %s", (_label, html) => expect(() => validatePrototypeHtml(html)).toThrow());

  it("enforces both independent byte budgets", () => {
    expect(() => validatePrototypeHtml("x".repeat(PROTOTYPE_HTML_MAX_BYTES + 1))).toThrow(/exceeds/);
    const payload = Buffer.alloc(PROTOTYPE_DATA_MAX_DECODED_BYTES + 1).toString("base64");
    expect(() => validatePrototypeHtml(`<img src="data:image/png;base64,${payload}">`)).toThrow(/decoded data/);
  });

  it("assembles a script-free static child CSP and preserves nonce-only plugin compatibility", () => {
    const staticDoc = assembleUntrustedSrcdoc(`<script>globalThis.pwned=1</script><p>safe</p>`, { mode: "prototype-static" });
    expect(staticDoc).toContain("script-src 'none'");
    expect(staticDoc).not.toContain("globalThis.pwned");
    expect(staticDoc).toContain("<p>safe</p>");
    expect(() => assembleUntrustedSrcdoc("<p>x</p>", { mode: "prototype-interactive", nonce: "" })).toThrow(/nonce/);
    expect(assembleUntrustedSrcdoc("<script>ok()</script>", { mode: "plugin", nonce: "abc" })).toContain('<script nonce="abc">');
  });
});
