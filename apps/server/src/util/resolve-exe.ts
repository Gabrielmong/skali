import fs from "node:fs";
import path from "node:path";

export interface ResolveExeOptions {
  /** PATH value to search. Defaults to the service's own PATH, which under LocalSystem is the machine PATH only. */
  pathEnv?: string;
  pathExt?: string;
  isFile?: (p: string) => boolean;
}

const defaultIsFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * CreateProcess never searches PATH for lpApplicationName, and a relative path would resolve against the
 * helper's cwd. So the server resolves before calling the helper:
 *  - absolute: returned as is
 *  - has a directory part (relative): resolved against `cwd` (the server folder)
 *  - bare name (e.g. "java"): searched in PATH using PATHEXT; null when not found
 */
export function resolveExe(exe: string, cwd: string, opts: ResolveExeOptions = {}): string | null {
  if (path.win32.isAbsolute(exe)) return exe;
  if (/[\/]/.test(exe)) return path.win32.resolve(cwd, exe);
  const isFile = opts.isFile ?? defaultIsFile;
  const dirs = (opts.pathEnv ?? process.env.PATH ?? "").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const exts = (opts.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExt = exts.some((x) => exe.toLowerCase().endsWith(x.toLowerCase()));
  const names = hasExt ? [exe] : exts.map((x) => exe + x.toLowerCase());
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = path.win32.join(dir, n);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Clear start-failure text for an executable that could not be resolved. */
export function exeNotFoundMessage(exe: string): string {
  return /^java(\.exe)?$/i.test(exe)
    ? "Java not found: install a JDK or set the Java path"
    : `"${exe}" was not found on the system PATH: set the full path to the executable`;
}
