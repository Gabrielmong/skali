import type { AppConfig } from "../config.js";
import type { Helper } from "../proc/helper.js";

/** The low-privilege local user game servers run as. */
export const GAMES_USER = "SkaliGames";

/**
 * Makes sure the games user exists with its logon rights and gives it a fresh password (done at every Skáli start;
 * the password lives only in memory). Returns null in dev/tests (`runAsCurrentUser`), where games run as the
 * current user and no user management happens.
 */
export async function ensureGamesUser(helper: Helper, cfg: AppConfig): Promise<{ name: string; password: string } | null> {
  if (cfg.runAsCurrentUser) return null;
  const { password } = await helper.ensureUser(GAMES_USER);
  return { name: GAMES_USER, password };
}
