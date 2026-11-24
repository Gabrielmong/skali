// Runs the pnpm that is running us, so root scripts never depend on a (possibly different) global `pnpm` on PATH.
// Usage in package.json scripts: node scripts/run-pnpm.mjs <pnpm args...>
import { spawnSync } from "node:child_process";

const exec = process.env.npm_execpath;
const useNode = exec && /\.(c|m)?js$/i.test(exec);
const [cmd, prefix] = useNode ? [process.execPath, [exec]] : [exec || "pnpm", []];
const r = spawnSync(cmd, [...prefix, ...process.argv.slice(2)], { stdio: "inherit", shell: !useNode && process.platform === "win32" });
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
