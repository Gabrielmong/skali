import { describe, expect, it } from "vitest";
import { system32Exe } from "../../src/system/run.js";
import { grantModify } from "../../src/system/acl.js";

describe("grantModify (fake runner only)", () => {
  it("passes the folder as a separate argv element", async () => {
    const calls: { exe: string; args: string[] }[] = [];
    await grantModify("C:\\games\\my server", "SkaliGames", async (exe, args) => { calls.push({ exe, args }); return { code: 0, stdout: "", stderr: "" }; });
    expect(calls).toEqual([{ exe: system32Exe("icacls.exe"), args: ["C:\\games\\my server", "/grant", "SkaliGames:(OI)(CI)M", "/Q"] }]);
  });
  it("throws with stderr on non-zero", async () => {
    await expect(grantModify("C:\\x", "U", async () => ({ code: 5, stdout: "", stderr: "Access is denied" }))).rejects.toThrow(/Access is denied/);
  });
  it("rejects folders containing a double quote", async () => {
    await expect(grantModify('C:\\x"y', "U", async () => ({ code: 0, stdout: "", stderr: "" }))).rejects.toThrow();
  });
});
