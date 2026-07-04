import { envelope } from "../shared/studio/protocol";
import type { AgentFixtureVM } from "./types";

export { readyMessage, READY } from "../shared/ready";

export const loadMessage = (entity: AgentFixtureVM) => envelope({ type: "load" as const, entity, concurrency: { kind: "none" as const } });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
