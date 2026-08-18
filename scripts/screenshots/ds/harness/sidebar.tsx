// spec 252 render harness — mounts the REAL sidebar <App> with the preview SAMPLE fleet so the
// screenshot exercises the dense list: icon tabs, status-dot rows, badges, the cmd+K bar — proving
// they follow the theme on --ds-* tokens after the migration.
import { render } from "preact";
import { App } from "@tachyon/webview-ui/webview/sidebar/App";
import { SAMPLE } from "../../../webview-preview/fixtures/sidebar";

const root = document.getElementById("root");
if (root) render(<App fleets={[SAMPLE]} />, root);
