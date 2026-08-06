import fs from "node:fs";
import path from "node:path";
import { loadProfileAwareConfig } from "<workspace-root>/src/config/agentProfileConfigLoader.js";

function run(label: string, workspaceRoot: string): void {
  console.log(`\n########## ${label}`);
  console.log(`root: ${workspaceRoot}`);
  const ymlPath = path.join(workspaceRoot, "tachyon.yml");
  if (!fs.existsSync(ymlPath)) {
    console.log("tachyon.yml: ABSENT -> no roster is declared at all");
    return;
  }
  const yamlText = fs.readFileSync(ymlPath, "utf8");
  const result = loadProfileAwareConfig({
    yamlText,
    workspaceRoot,
    // A new path means a new wsHash, which means a SecretStorage key that was
    // never written. This is what the extension host would read there.
    authorities: new Map(),
  });
  console.log(`config loaded: ${result.config ? "yes" : "no"}`);
  console.log(`agents projected: ${result.config ? JSON.stringify(Object.keys(result.config.agents)) : "-"}`);
  if (result.config) {
    for (const [name, source] of Object.entries(result.config.agentSources)) {
      console.log(`  ${name}: mode=${source.mode}${"reason" in source ? ` reason=${source.reason}` : ""}`);
    }
  }
  console.log(`errors: ${JSON.stringify(result.errors, null, 2)}`);
  console.log(`profileErrors: ${JSON.stringify(result.profileErrors, null, 2)}`);
}

const clone = process.argv[2]!;
run(process.argv[3]!, clone);
