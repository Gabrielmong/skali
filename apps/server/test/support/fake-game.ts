import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/server/test/support -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const toolExe = (name: string) => path.join(repoRoot, "tools", name, "publish", `${name}.exe`);

export const fakeGamePath = toolExe("FakeGame");
export const helperExePath = toolExe("SkaliHelper");

/** Newest mtime of the project's .cs / .csproj sources (bin/, obj/, publish/ excluded). */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["bin", "obj", "publish"].includes(entry.name)) newest = Math.max(newest, newestSourceMtime(p));
    } else if (/\.(cs|csproj)$/i.test(entry.name)) {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

/**
 * Publishes SkaliHelper and FakeGame (self-contained single-file) when their publish/ exe is missing
 * or older than any of their sources, so tests never run a stale binary.
 */
export function ensurePublished(): void {
  for (const name of ["SkaliHelper", "FakeGame"]) {
    const project = path.join(repoRoot, "tools", name);
    const exe = toolExe(name);
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= newestSourceMtime(project)) continue;
    execFileSync(
      "dotnet",
      ["publish", project, "-c", "Release", "-r", "win-x64", "--self-contained", "-p:PublishSingleFile=true", "-o", path.join(project, "publish")],
      { stdio: "pipe", windowsHide: true },
    );
  }
}
