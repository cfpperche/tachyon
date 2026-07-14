import path from "node:path";
import { spawnSync } from "node:child_process";

const runner = path.resolve("scripts/dogfood/persistent-engine-runner.ts");
const viteNode = path.resolve("node_modules/vite-node/vite-node.mjs");
const result = spawnSync(process.execPath, [viteNode, runner], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
