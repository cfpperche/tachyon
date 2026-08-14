import { describe, expect, it } from "vitest";
import { isConsentBlocked, viewAckRequirements, viewConsentRows } from "@tachyon/webview-ui/webview/plugins/consentViewAcks";
import { confirmMessage } from "@tachyon/webview-ui/webview/plugins/messages";
import type { ConsentVM } from "@tachyon/webview-ui/plugins/consentViewModel";

const vm: ConsentVM = {
  op: "install",
  pluginName: "terrarium",
  version: "1.0.0",
  title: "Install terrarium@1.0.0",
  confirmLabel: "Install",
  token: "view-token-123",
  views: [{
    id: "terrarium",
    title: "Terrarium",
    surface: "sidebar",
    entry: "ui/index.html",
    fleet: "summary",
    disclosure: "Draws UI in your editor and reads a name-free summary of your fleet.",
    actions: [{ name: "focusAgent", disclosure: "Can ask Tachyon to reveal an agent terminal to you; terminal contents may be visible on screen." }],
  }],
  requiresViewConfirm: true,
  requiresFleetReadConfirm: true,
  requiresActionConfirm: {
    "terrarium:focusAgent": "Can ask Tachyon to reveal an agent terminal to you; terminal contents may be visible on screen.",
  },
};

describe("Plugins consent drawer view acknowledgements", () => {
  it("surfaces the views section rows and required acknowledgement checkboxes", () => {
    expect(viewConsentRows(vm)).toEqual([{
      id: "terrarium",
      title: "Terrarium",
      surface: "sidebar",
      entry: "ui/index.html",
      disclosure: "Draws UI in your editor and reads a name-free summary of your fleet.",
      actions: [{ name: "focusAgent", disclosure: "Can ask Tachyon to reveal an agent terminal to you; terminal contents may be visible on screen." }],
    }]);
    expect(viewAckRequirements(vm).map((r) => r.key)).toEqual(["view", "fleetRead", "terrarium:focusAgent"]);
  });

  it("keeps install blocked until all view acknowledgements are present", () => {
    expect(isConsentBlocked(vm, { viewAck: true, fleetReadAck: true, actionAck: {} })).toBe(true);
    expect(isConsentBlocked(vm, { viewAck: true, fleetReadAck: true, actionAck: { "terrarium:focusAgent": true } })).toBe(false);
  });

  it("carries view acknowledgement fields in confirm messages", () => {
    expect(confirmMessage({
      token: vm.token,
      viewConfirmed: true,
      fleetReadConfirmed: true,
      actionConfirmed: { "terrarium:focusAgent": true },
    })).toEqual({
      type: "confirm",
      token: vm.token,
      viewConfirmed: true,
      fleetReadConfirmed: true,
      actionConfirmed: { "terrarium:focusAgent": true },
    });
  });
});
