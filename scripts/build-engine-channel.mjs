import { spawnSync } from "node:child_process";
import { ENGINE_RELEASE_CHANNELS } from "./engine-release-channel.mjs";

const channel = process.argv[2] || "dev";
if (!ENGINE_RELEASE_CHANNELS.includes(channel)) throw new Error(`expected build channel stable or dev, got '${channel}'`);
const result = spawnSync(process.execPath, ["esbuild.mjs", ...process.argv.slice(3)], {
  cwd: process.cwd(),
  env: { ...process.env, TACHYON_ENGINE_CHANNEL: channel },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
