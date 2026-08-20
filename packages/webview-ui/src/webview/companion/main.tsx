import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import type { CockpitAction, CockpitStrings, CompanionPairOffer } from "../shared/control/messages";
import { CompanionApp } from "./App";
import { MODEL, pollMessage, readyMessage, type CompanionModel } from "./messages";
import "./companion.css";
declare function acquireVsCodeApi(): TachyonVsCodeApi;
const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const post = (message: CockpitAction | ReturnType<typeof pollMessage>) => api?.postMessage(message) ?? window.postMessage(message, "*");
function Root() { const [model, setModel] = useState<CompanionModel>(); const [offer, setOffer] = useState<CompanionPairOffer>(); const s = (window as any).__TACHYON_STRINGS__ as CockpitStrings; useEffect(() => { const h = (e: MessageEvent) => { if (e.data?.type === MODEL) setModel(e.data.model); if (e.data?.type === "companionPairOffer") setOffer(e.data.offer); }; window.addEventListener("message", h); post(readyMessage()); const id = setInterval(() => post(pollMessage()), 3000); return () => { clearInterval(id); window.removeEventListener("message", h); }; }, []); return model ? <CompanionApp companion={model.companion} needsWorkspacePick={model.needsWorkspacePick} offer={offer} s={s} post={post} /> : null; }
persistWebviewState(api); render(<ErrorBoundary><Root /></ErrorBoundary>, document.getElementById("root")!);
