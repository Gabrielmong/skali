import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  dataDir: string;
  port: number;
  helperPath: string;
  runAsCurrentUser: boolean;
  webDist: string;
  initialAllowlist: string[];
  /** The deploy helper's API (SKALI_DEPLOYER_URL). */
  deployerUrl: string;
  /** File holding the helper's API token (SKALI_DEPLOYER_TOKEN_FILE). */
  deployerTokenFile: string;
}

// apps/server/src -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const allowlist = env.SKALI_INITIAL_ALLOWLIST;
  const dataDir = env.SKALI_DATA_DIR || "C:\\ProgramData\\Skali";
  return {
    dataDir,
    deployerUrl: env.SKALI_DEPLOYER_URL || "http://127.0.0.1:4201",
    deployerTokenFile: env.SKALI_DEPLOYER_TOKEN_FILE || path.win32.join("C:\\SkaliDeploy", "deployer", "api-token"),
    port: env.SKALI_PORT ? Number(env.SKALI_PORT) : 4200,
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
