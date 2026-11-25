import { describe, expect, it } from "vitest";
import { system32Exe } from "../../src/system/run.js";
import { grantModify, grantReadExecute } from "../../src/system/acl.js";

describe("grantModify (fake runner only)", () => {
  it("passes the folder as a separate argv element and /L (acts on a link itself, never its target)", async () => {
    const calls: { exe: string; args: string[] }[] = [];
    await grantModify("C:\\games\\my server", "SkaliGames", async (exe, args) => { calls.push({ exe, args }); return { code: 0, stdout: "", stderr: "" }; });
    expect(calls).toEqual([{ exe: system32Exe("icacls.exe"), args: ["C:\\games\\my server", "/grant", "SkaliGames:(OI)(CI)M", "/L", "/Q"] }]);
  });
  it("throws with stderr on non-zero", async () => {
    await expect(grantModify("C:\\x", "U", async () => ({ code: 5, stdout: "", stderr: "Access is denied" }))).rejects.toThrow(/Access is denied/);
  });
  it("rejects folders containing a double quote", async () => {
    await expect(grantModify('C:\\x"y', "U", async () => ({ code: 0, stdout: "", stderr: "" }))).rejects.toThrow();
  });
});

describe("grantReadExecute (fake runner only)", () => {
  it("grants (OI)(CI)RX with the folder as its own argv element and /L", async () => {
    const calls: { exe: string; args: string[] }[] = [];
    await grantReadExecute("C:\\tools\\java", "SkaliGames", async (exe, args) => { calls.push({ exe, args }); return { code: 0, stdout: "", stderr: "" }; });
    expect(calls).toEqual([{ exe: system32Exe("icacls.exe"), args: ["C:\\tools\\java", "/grant", "SkaliGames:(OI)(CI)RX", "/L", "/Q"] }]);
  });
  it("throws on non-zero and on a quote in the path", async () => {
    await expect(grantReadExecute("C:\\x", "U", async () => ({ code: 5, stdout: "", stderr: "Access is denied" }))).rejects.toThrow(/Access is denied/);
    await expect(grantReadExecute('C:\\x"y', "U", async () => ({ code: 0, stdout: "", stderr: "" }))).rejects.toThrow();
  });
});
