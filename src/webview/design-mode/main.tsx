import { render } from "preact";
import { ErrorBoundary } from "../shared/ErrorBoundary.js";
import { App } from "./App.js";
render(<ErrorBoundary><App /></ErrorBoundary>, document.getElementById("root")!);
