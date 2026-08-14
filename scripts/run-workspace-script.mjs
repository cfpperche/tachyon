import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) throw new Error("run-workspace-script: expected a script path");

try {
  const module = await import(pathToFileURL(path.resolve(target)).href);
  if (typeof module.main === "function") process.exitCode = await module.main();
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" && /package ['\"]@tachyon\//.test(String(error.message))) {
    process.stderr.write(
      "Tachyon workspace package links are missing in this checkout. Run `npm install`, then retry.\n",
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
