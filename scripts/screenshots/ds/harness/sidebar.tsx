// spec 252 render harness — mounts the REAL sidebar <App> with its built-in SAMPLE fleet (the App defaults
// `fleets = [SAMPLE]`), so the screenshot exercises the dense list: icon tabs, status-dot rows, badges, the
// cmd+K bar, and the Bridge footer — proving they follow the theme on --ds-* tokens after the migration.
import { render } from "preact";
import { App } from "../../../../src/webview/sidebar/App";

const root = document.getElementById("root");
if (root) render(<App />, root);
