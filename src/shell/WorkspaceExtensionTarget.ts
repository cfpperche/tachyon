import { randomUUID } from "node:crypto";
import type {
  ExtensionCommandV1,
  ExtensionQueryV1,
  JsonValue,
} from "@tachyon/engine/runtime-api/extensionOperations.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { workspacePresentationTarget, type WorkspacePresentationTarget } from "./WorkspacePresentation.js";

export interface WorkspaceExtensionTarget extends WorkspacePresentationTarget {
  readonly bridgeUrl: string;
  query(input: ExtensionQueryV1): Promise<JsonValue>;
  invoke(input: ExtensionCommandV1): Promise<JsonValue>;
}

/** Shell-only adapter for the finite operational commands that do not belong to a panel contract. */
export function workspaceExtensionTarget(client: WorkspaceClient): WorkspaceExtensionTarget {
  return {
    ...workspacePresentationTarget(client),
    bridgeUrl: client.bridgeUrl,
    query: async (input) => {
      const result = await client.query({ schemaVersion: 1, method: "extension.query", input });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "extension.query" || result.action !== input.action) {
        throw new Error("extension query returned a mismatched result");
      }
      return result.value;
    },
    invoke: async (input) => {
      const result = await client.invoke(`extension:${randomUUID()}`, {
        schemaVersion: 1,
        method: "extension.invoke",
        input,
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "extension.invoke" || result.action !== input.action) {
        throw new Error("extension command returned a mismatched result");
      }
      return result.value;
    },
  };
}
