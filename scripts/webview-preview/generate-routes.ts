import { writeFileSync } from "node:fs";
import { buildCatalog } from "./routes";

const output = "scripts/webview-preview/routes.json";
writeFileSync(output, `${JSON.stringify(buildCatalog(), null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${output}\n`);
