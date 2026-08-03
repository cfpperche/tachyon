import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CockpitModel } from "../../cockpit/model";
import type { CockpitStrings } from "../cockpit/messages";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, defaultStrings } from "./App";
import { ENGINE_MODEL, pollEngineAction, readyMessage, type EngineAction } from "./messages";
declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: EngineAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");
function Root(){const [model,setModel]=useState<CockpitModel>();const strings=(window as unknown as {__TACHYON_STRINGS__?:CockpitStrings}).__TACHYON_STRINGS__ ?? defaultStrings;useEffect(()=>{const on=(e:MessageEvent)=>{if(e.data?.type===ENGINE_MODEL)setModel(e.data.model)};window.addEventListener("message",on);post(readyMessage());const timer=setInterval(()=>post(pollEngineAction()),3000);return()=>{clearInterval(timer);window.removeEventListener("message",on)}},[]);return <App model={model} strings={strings} post={post}/>}
const root=document.getElementById("root");if(root)render(<ErrorBoundary><Root/></ErrorBoundary>,root);
