import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  dataDir: string;
  port: number;
  helperPath: string;
  runAsCurrentUser: boolean;
  webDist: string;
  initialAllowlist: string[];
}

// apps/server/src -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowlist = env.SKALI_INITIAL_ALLOWLIST;
  return {
    dataDir: env.SKALI_DATA_DIR || "C:\\ProgramData\\Skali",
    port: env.SKALI_PORT ? Number(env.SKALI_PORT) : 4100,
    helperPath: path.join(repoRoot, "tools", "SkaliHelper", "publish", "SkaliHelper.exe"),
    runAsCurrentUser: env.SKALI_RUN_AS_CURRENT_USER === "1" || env.SKALI_RUN_AS_CURRENT_USER === "true",
    webDist: path.join(repoRoot, "apps", "web", "dist"),
    initialAllowlist: allowlist
      ? allowlist.split(",").map((s) => s.trim()).filter(Boolean)
      : ["192.168.0.150"],
  };
}

export function dataPaths(dataDir: string): { db: string; secretKey: string; logs: string; serviceLog: string } {
  const j = path.win32.join;
  return {
    db: j(dataDir, "skali.db"),
    secretKey: j(dataDir, "secret.key"),
    logs: j(dataDir, "logs"),
    serviceLog: j(dataDir, "service.log"),
  };
}
