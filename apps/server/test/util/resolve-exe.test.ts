import { describe, expect, it } from "vitest";
import { exeNotFoundMessage, resolveExe } from "../../src/util/resolve-exe.js";

const files = new Set(["C:\\Java\\bin\\java.exe", "C:\\Tools\\run.cmd", "D:\\other\\java.exe"].map((f) => f.toLowerCase()));
const isFile = (p: string) => files.has(p.toLowerCase());
const o = { pathEnv: "C:\\Windows;C:\\Java\\bin;D:\\other", pathExt: ".COM;.EXE;.BAT;.CMD", isFile };

describe("resolveExe", () => {
  it("finds a bare name via PATH + PATHEXT, first directory wins", () => {
    expect(resolveExe("java", "C:\\srv", o)).toBe("C:\\Java\\bin\\java.exe");
    expect(resolveExe("run", "C:\\srv", { ...o, pathEnv: "C:\\Tools" })).toBe("C:\\Tools\\run.cmd");
  });
  it("accepts a name that already has a PATHEXT extension", () => {
    expect(resolveExe("java.exe", "C:\\srv", o)).toBe("C:\\Java\\bin\\java.exe");
  });
  it("returns null when nothing matches or PATH is empty", () => {
    expect(resolveExe("node", "C:\\srv", o)).toBeNull();
    expect(resolveExe("java", "C:\\srv", { ...o, pathEnv: "" })).toBeNull();
  });
  it("passes absolute paths through untouched, even if missing", () => {
    expect(resolveExe("C:\\nope\\x.exe", "C:\\srv", o)).toBe("C:\\nope\\x.exe");
  });
  it("resolves a relative path with a directory part against the server folder", () => {
    expect(resolveExe("bin\\java.exe", "C:\\srv", o)).toBe("C:\\srv\\bin\\java.exe");
    expect(resolveExe(".\\run.exe", "C:\\srv", o)).toBe("C:\\srv\\run.exe");
  });
  it("tolerates quoted PATH entries and blanks", () => {
    expect(resolveExe("java", "C:\\srv", { ...o, pathEnv: ";\"C:\\Java\\bin\";" })).toBe("C:\\Java\\bin\\java.exe");
  });
  it("explains a missing java clearly", () => {
    expect(exeNotFoundMessage("java")).toBe("Java not found: install a JDK or set the Java path");
    expect(exeNotFoundMessage("foo")).toContain("not found on the system PATH");
  });
});
