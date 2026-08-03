/**
 * SDD 485 C1–C3 — the wire protocol of the section-app proof surface. Deliberately tiny and deliberately in
 * the PUSH dialect rather than the studio's entity/dirty/save one: the host owns a model and posts it; the
 * app renders what it is given and asks for a refresh. That is the shape every one of the twelve dashboards
 * and every document app has, and it is what `SectionPanelManager` is built around.
 *
 * DOM-free, so the vscode-bound host may import it under the extension-host tsconfig.
 */

import { READY } from "../shared/ready.js";

/** What the app renders. Everything here is an OBSERVATION of the mechanism, not domain data. */
export interface SectionFixtureModel {
  /** the manifest `view` this bundle was built from. */
  app: string;
  /** the manifest cardinality that decided this panel's key. */
  cardinality: string;
  /** the manager's key for this panel — the visible proof that two identities are two panels. */
  key: string;
  project: string;
  identity: string;
  /** how many models this panel has been posted. A hidden panel's count must not move. */
  revision: number;
  /**
   * What the host did last. Only two values, and that is a design claim rather than an omission: the first
   * push after `ready` runs the SAME `replay` path a fan-out invalidation runs, so this app has no
   * bespoke "load" branch for a catch-up to diverge from (panelWorkGate.ts's reasoning, one layer up).
   */
  lastPush: "replay" | "resync";
}

export const SECTION_FIXTURE_MODEL = "section-fixture/model";
/** spec 278's SHARED handshake, not a surface-local one: the dev preview harness waits for exactly this
 *  message before injecting a fixture, so a view that invents its own `ready` never renders there. */
export const SECTION_FIXTURE_READY = READY;
/** The client's own periodic poll — the door Phase B found open on Control, gated host-side here. */
export const SECTION_FIXTURE_REFRESH = "section-fixture/refresh";

export type SectionFixtureFromHost = { type: typeof SECTION_FIXTURE_MODEL; model: SectionFixtureModel };
export type SectionFixtureToHost =
  | { type: typeof SECTION_FIXTURE_READY }
  | { type: typeof SECTION_FIXTURE_REFRESH };

export const sectionFixtureModelMessage = (model: SectionFixtureModel): SectionFixtureFromHost => ({ type: SECTION_FIXTURE_MODEL, model });
export const sectionFixtureReadyMessage = (): SectionFixtureToHost => ({ type: SECTION_FIXTURE_READY });
export const sectionFixtureRefreshMessage = (): SectionFixtureToHost => ({ type: SECTION_FIXTURE_REFRESH });

/** the ONE place that decides whether an inbound message is the client asking for work (see
 *  `SectionAppConfig.refreshKindFor`): a string compare the host does, never a client promise. */
export function sectionFixtureRefreshKind(message: unknown): "model" | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === SECTION_FIXTURE_REFRESH || type === SECTION_FIXTURE_READY ? "model" : undefined;
}
