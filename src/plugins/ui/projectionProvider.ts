import type { FleetVM } from "@tachyon/shared/sidebar/types.js";
import { READY } from "./messages.js";
import { pluginFleetProjectionMessage, type PluginUiHostMessage } from "./messages.js";
import { toPluginProjectionV1, type PluginProjectionHandleMint, type PluginProjectionLabelMint, type PluginProjectionTarget } from "./projectionBuilder.js";
import type { PluginFleetProjectionV1 } from "./projectionTypes.js";

export interface PluginProjectionSink {
  postMessage(message: PluginUiHostMessage): boolean | Promise<boolean>;
}

export class PluginProjectionSession {
  private readonly labels = new Map<string, string>();

  labelFor(target: PluginProjectionTarget): string {
    const key = targetKey(target);
    const existing = this.labels.get(key);
    if (existing) return existing;
    const next = `Agent ${this.labels.size + 1}`;
    this.labels.set(key, next);
    return next;
  }
}

export class PluginFleetProjectionProvider {
  private generation = 0;
  private lastProjection?: PluginFleetProjectionV1;
  private readonly defaultSession = new PluginProjectionSession();
  private readonly mintLabel: PluginProjectionLabelMint;

  constructor(
    private readonly sink: PluginProjectionSink,
    private readonly mintHandle: PluginProjectionHandleMint,
    mintLabel?: PluginProjectionLabelMint,
  ) {
    this.mintLabel = mintLabel ?? this.defaultSession.labelFor.bind(this.defaultSession);
  }

  refresh(fleets: FleetVM | readonly FleetVM[]): PluginFleetProjectionV1 {
    this.generation += 1;
    const projection = toPluginProjectionV1(fleets, this.generation, this.mintHandle, this.mintLabel);
    this.lastProjection = projection;
    void this.sink.postMessage(pluginFleetProjectionMessage(projection));
    return projection;
  }

  handleMessage(message: { type?: string } | undefined): void {
    if (message?.type !== READY || !this.lastProjection) return;
    void this.sink.postMessage(pluginFleetProjectionMessage(this.lastProjection));
  }
}

function targetKey(target: PluginProjectionTarget): string {
  return `${target.wsHash ?? target.fleetIndex}:${target.name}`;
}
