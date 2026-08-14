// spec 349 T1 — the outer relay bundle for the opaque-origin iframe contract gate. Loaded as the shell's
// nonce'd bundle script (see pluginFrameGate.ts). It has NO authority of its own: it mounts a sandboxed
// `srcdoc` iframe standing in for an untrusted plugin document, relays a two-way postMessage ping/pong, and
// reads back — verbatim, un-interpreted — whatever the framed document reports about its own attempts to
// reach the parent DOM, storage, and the network. Plain vanilla JS, no build step (dev/test-only asset, never
// shipped): a real production relay lands in `packages/webview-ui/src/webview/plugin-host/*` at T10, out of T1's scope.

// the stand-in "untrusted plugin document" — entirely self-contained (D9's eventual entry-HTML validator would
// accept a doc shaped exactly like this: inline script only, no remote/vscode-webview-resource URLs, no nested
// iframe). Its OWN <meta> CSP is a second, independent layer of defense-in-depth — the isolation this gate
// actually proves comes from `sandbox="allow-scripts"` (no `allow-same-origin`) on the outer <iframe>, below.
//
// FINDING (spec 349 T1 spike): a `srcdoc` document's CSP list is the UNION of its own <meta> policy AND the
// embedder's inherited policy — not a replacement. Chrome enforces BOTH simultaneously. So this doc's inline
// script is ALSO checked against the outer shell's `script-src 'nonce-…'`, and is blocked without a matching
// nonce even though its own meta tag says `'unsafe-inline'`. The correct fix is NOT to relax the outer
// script-src (that would reopen inline-script injection on the trusted relay bundle itself) — it's for the
// TRUSTED relay to stamp its OWN current nonce onto the plugin doc's script tag at srcdoc-assembly time. The
// plugin ships nonce-less markup; only the first-party assembler ever sees/injects the live nonce. This is a
// real consequence for T10's production relay + D9's entry-HTML validator, not just this spike.
function pluginDocFor(nonce, fetchTarget) {
  // fetchTarget is a REAL, always-200, same-server URL (not a non-resolving hostname) — the network probe must
  // fail because connect-src blocked it, not incidentally because DNS failed for an unrelated reason.
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'none'">
<title>untrusted plugin doc</title></head><body>
<script nonce="${nonce}">
(function () {
  function report(key, blocked, detail) {
    parent.postMessage({ type: "probe", key: key, blocked: blocked, detail: String(detail || "") }, "*");
  }
  // (a) parent DOM reach — an opaque-origin sandboxed frame (no allow-same-origin) must be DENIED read access.
  try {
    void window.parent.document;
    report("parentDom", false, "read window.parent.document without throwing");
  } catch (e) {
    report("parentDom", true, e && e.message);
  }
  // (b) storage reach — same opaque-origin restriction applies to Storage objects.
  try {
    window.localStorage.setItem("x", "1");
    report("storage", false, "localStorage.setItem succeeded");
  } catch (e) {
    report("storage", true, e && e.message);
  }
  // (c) network reach — this document's OWN connect-src 'none' must block fetch of a URL that would otherwise
  // resolve fine (same server, always 200) — proving the block is CSP, not an incidental DNS failure.
  fetch(${JSON.stringify(fetchTarget)}).then(function () {
    report("network", false, "fetch resolved");
  }).catch(function (e) {
    report("network", true, e && e.message);
  });
  // (d) the channel still WORKS despite (a)-(c): a two-way postMessage relay is not blocked by the sandbox.
  window.addEventListener("message", function (e) {
    if (e.data && e.data.type === "ping") parent.postMessage({ type: "pong", n: e.data.n }, "*");
  });
  report("mounted", true, "plugin doc executed");
})();
</script>
</body></html>`;
}

// this script's OWN nonce (set by renderWebviewShell on this very <script> tag) — the ONE piece of trusted-host
// material the plugin doc borrows, and only because THIS relay is the one assembling its srcdoc, live, per
// render. The plugin author never sees or supplies it. MUST be read at top-level, synchronously — outside any
// callback, `document.currentScript` is null (it's only live during this script's OWN initial execution).
const RELAY_NONCE = document.currentScript.nonce || document.currentScript.getAttribute("nonce");

function mount() {
  const root = document.getElementById("root");

  window.__pluginFrameGateResults = { mounted: null, parentDom: null, storage: null, network: null, pong: null };

  const status = document.createElement("pre");
  status.id = "status";
  status.textContent = "mounting…";
  root.appendChild(status);

  const iframe = document.createElement("iframe");
  iframe.id = "plugin-frame";
  iframe.setAttribute("sandbox", "allow-scripts"); // NEVER allow-same-origin — the whole point of this gate.
  iframe.style.cssText = "width:480px;height:220px;border:1px solid #888;display:block";
  iframe.srcdoc = pluginDocFor(RELAY_NONCE, location.origin + "/scripts/webview-preview/plugin-frame-relay.js");

  window.addEventListener("message", function (e) {
    const d = e.data;
    if (!d) return;
    if (d.type === "probe") window.__pluginFrameGateResults[d.key] = { blocked: d.blocked, detail: d.detail };
    else if (d.type === "pong") window.__pluginFrameGateResults.pong = d.n;
    status.textContent = JSON.stringify(window.__pluginFrameGateResults, null, 2);
    status.dataset.ready = "1";
  });

  iframe.addEventListener("load", function () {
    iframe.contentWindow.postMessage({ type: "ping", n: 1 }, "*");
  });

  root.appendChild(iframe);
}

document.addEventListener("DOMContentLoaded", mount);
