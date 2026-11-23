export const CRASH_WINDOW_MS = 600_000;
export const CRASH_LIMIT = 3;
export const RESTART_DELAY_MS = 10_000;

export type CrashAction = { action: "restart"; delayMs: 10000 } | { action: "pause" };

/** `crashTimes` includes the current crash. Pauses when auto-restart is off or after 3 crashes within 10 minutes. */
export function nextCrashAction(crashTimes: number[], now: number, autoRestart: boolean): CrashAction {
  if (!autoRestart) return { action: "pause" };
  const recent = crashTimes.filter((t) => t <= now && now - t < CRASH_WINDOW_MS).length;
  if (recent >= CRASH_LIMIT) return { action: "pause" };
  return { action: "restart", delayMs: RESTART_DELAY_MS };
}
