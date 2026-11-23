// Stand-in for the Skáli service process: runs a Supervisor, starts a server, prints STARTED <pid>, then idles.
// Config via SKALI_HOST_CFG (JSON): { dbPath, logsDir, helperPath, serverId, secretKeyHex }.
import { openDb } from "../../src/db.js";
import { createHelper } from "../../src/proc/helper.js";
import { Supervisor } from "../../src/proc/supervisor.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { fakeGameAdapter } from "../support/survival-adapter.js";

const cfg = JSON.parse(process.env.SKALI_HOST_CFG!) as {
  dbPath: string; logsDir: string; helperPath: string; serverId: string; secretKeyHex: string;
};
const db = openDb(cfg.dbPath);
const repo = new ServerRepo(db, Buffer.from(cfg.secretKeyHex, "hex"));
const sup = new Supervisor({
  repo,
  helper: createHelper(cfg.helperPath),
  adapter: () => fakeGameAdapter,
  logsDir: cfg.logsDir,
  gamesUser: null,
  emit: () => undefined,
});
await sup.start(cfg.serverId);
const rec = repo.get(cfg.serverId);
if (rec.pid === null) {
  console.error("launch failed: " + (sup.state(cfg.serverId).detail ?? "unknown"));
  process.exit(1);
}
console.log(`STARTED ${rec.pid}`);
setInterval(() => undefined, 1 << 30);
