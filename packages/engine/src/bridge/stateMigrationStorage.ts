import type { EngineStateMigrationStorage } from "../engine-service/stateMigration.js";
import { bridgeGenerationStateKey } from "./clientRebind.js";
import { bridgeTokenFileName, externalBridgeTokenFileName } from "./token.js";

/** The transport owns the stable disk locations consumed during the one-time engine migration. */
export const bridgeStateMigrationStorage = {
  tokenFileNames: (workspaceHash: string) => ({
    bridge: bridgeTokenFileName(workspaceHash),
    external: externalBridgeTokenFileName(workspaceHash),
  }),
  clientGenerationStateKey: bridgeGenerationStateKey,
} satisfies EngineStateMigrationStorage;
