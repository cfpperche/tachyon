import type { KeysModel } from "@tachyon/webview-ui/webview/keys/messages";
import type { Fixture, Route } from "../routes";
export const keysFixtures: Record<string, Fixture<KeysModel>> = {
  default: { provenance: "synthetic-edge", vm: { stored: [{ provider: "anthropic", id: "api-key", usedBy: ["claude", "reviewer"] }, { provider: "zai", id: "glm-coding-pro", usedBy: [] }], missing: [{ agent: "glm", name: "coding", provider: "zai", id: "glm-5.3", purpose: "model access" }] } },
};
export type KeysRoute = Route<KeysModel>;
