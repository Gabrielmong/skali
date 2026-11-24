import { spawn } from "node:child_process";
import path from "node:path";

export interface ProcResult { code: number; stdout: string; stderr: string }

export const systemRoot = (): string => process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
export const system32Exe = (rel: string): string => path.win32.join(systemRoot(), "System32", rel);

/** Runs an executable directly (no shell); args are passed as separate argv elements. */
export function runProcess(exe: string, args: string[], stdin?: string, env?: Record<string, string>): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.on("error", () => { /* the process may exit before reading stdin */ });
    child.stdin.end(stdin ?? "");
  });
}

const MAX_ENCODED = 30000; // Windows command lines are limited to ~32K characters

/**
 * Runs a PowerShell script as one unit (-EncodedCommand), so a terminating error aborts it and exits non-zero.
 * Values must be passed via `env` (names starting with SKALI_), never interpolated into the script.
 */
export async function runPowerShell(script: string, env?: Record<string, string>): Promise<string> {
  for (const k of Object.keys(env ?? {})) if (!k.startsWith("SKALI_")) throw new Error(`Environment variable ${k} must start with SKALI_`);
  const wrapped = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { ${script}\n} catch { [Console]::Error.WriteLine($_); exit 1 }`;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  if (encoded.length > MAX_ENCODED) throw new Error("PowerShell script too large");
  const exe = system32Exe("WindowsPowerShell\\v1.0\\powershell.exe");
  const r = await runProcess(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], undefined, env);
  if (r.code !== 0) throw new Error(`PowerShell failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
