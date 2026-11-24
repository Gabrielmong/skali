import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { ensureFirewallRules, firewallRuleName, removeFirewallRules, ruleBelongsTo, rulesLoop } from "../../src/system/firewall.js";
import { runPowerShell, runProcess } from "../../src/system/run.js";

const valheimPorts = [
  { port: 2456, protocol: "udp" as const, purpose: "game", forward: true },
  { port: 2457, protocol: "udp" as const, purpose: "game+1", forward: true },
  { port: 2458, protocol: "udp" as const, purpose: "game+2", forward: true },
  { port: 9999, protocol: "tcp" as const, purpose: "local only", forward: false },
];
type Call = { script: string; env: Record<string, string> };
const recorder = () => {
  const calls: Call[] = [];
  return { calls, run: async (script: string, env?: Record<string, string>) => { calls.push({ script, env: env ?? {} }); return ""; } };
};

describe("firewall (fake runner only)", () => {
  it("names rules", () => {
    expect(firewallRuleName("friends", valheimPorts[0]!)).toBe("Skali - friends - 2456/UDP");
  });

  it("passes names and ports via env, one rule per forwarded port", async () => {
    const { calls, run } = recorder();
    await ensureFirewallRules("friends", valheimPorts, run);
    const { script, env } = calls[0]!;
    expect(script).toContain("New-NetFirewallRule");
    expect(script).toContain("-Group 'Skali'");
    expect(script).not.toContain("friends");
    expect(script).not.toContain("2456");
    expect(env.SKALI_PREFIX).toBe("Skali - friends - ");
    expect(JSON.parse(env.SKALI_RULES!)).toEqual([
      { name: "Skali - friends - 2456/UDP", port: 2456, proto: "UDP" },
      { name: "Skali - friends - 2457/UDP", port: 2457, proto: "UDP" },
      { name: "Skali - friends - 2458/UDP", port: 2458, proto: "UDP" },
    ]);
    expect(Object.keys(env).every((k) => k.startsWith("SKALI_"))).toBe(true);
    expect(script.indexOf("Remove-NetFirewallRule")).toBeLessThan(script.indexOf("New-NetFirewallRule"));
  });

  it("rejects names with quotes before running anything", async () => {
    const { calls, run } = recorder();
    await expect(ensureFirewallRules("Bob's", valheimPorts, run)).rejects.toBeInstanceOf(BadRequestError);
    await expect(removeFirewallRules("a[x]*?", run)).rejects.toBeInstanceOf(BadRequestError);
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid ports and protocols", async () => {
    const { run } = recorder();
    for (const bad of [{ port: 0 }, { port: 70000 }, { port: 1.5 }, { port: Number.NaN }, { protocol: "icmp" }]) {
      await expect(ensureFirewallRules("friends", [{ ...valheimPorts[0]!, ...bad } as never], run)).rejects.toBeInstanceOf(BadRequestError);
    }
    // non-forwarded ports are not validated or emitted
    await ensureFirewallRules("friends", [{ ...valheimPorts[0]!, port: 0, forward: false }], run);
  });

  it("removal script is grouped, anchored, wildcard-free and takes the prefix from env", async () => {
    const { calls, run } = recorder();
    await removeFirewallRules("a.b", run);
    const { script, env } = calls[0]!;
    expect(script).not.toMatch(/-like/i);
    expect(script).toContain("-Group 'Skali'");
    expect(script).toContain("-ErrorAction SilentlyContinue");
    expect(script).toContain("'^\\d{1,5}/(UDP|TCP)$'");
    expect(script).toContain("[StringComparison]::Ordinal");
    expect(script).toContain("$env:SKALI_PREFIX");
    expect(script).not.toContain("a.b");
    expect(env).toEqual({ SKALI_PREFIX: "Skali - a.b - " });
  });

  it("removal for 'a' does not match rules of 'a - b'", () => {
    expect(ruleBelongsTo("a", "Skali - a - 2456/UDP")).toBe(true);
    expect(ruleBelongsTo("a", "Skali - a - b - 2456/UDP")).toBe(false);
    expect(ruleBelongsTo("a - b", "Skali - a - b - 2456/UDP")).toBe(true);
    expect(ruleBelongsTo("a", "Skali - a - 2456/ICMP")).toBe(false);
    expect(ruleBelongsTo("a", "Skali - a - 99999999/UDP")).toBe(false);
  });
});

describe("run (harmless commands only)", () => {
  it("runProcess captures output and exit code", async () => {
    const r = await runProcess("cmd", ["/c", "echo hi"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hi");
  });
  it("runPowerShell returns stdout and passes env", async () => {
    expect((await runPowerShell("Write-Output 1")).trim()).toBe("1");
    expect((await runPowerShell("Write-Output $env:SKALI_X", { SKALI_X: "it's [x]*" })).trim()).toBe("it's [x]*");
  });
  it("the rules loop iterates once per rule (real PS, Write-Output instead of New-NetFirewallRule)", async () => {
    const two = JSON.stringify([{ name: "A - 1/UDP", port: 1, proto: "UDP" }, { name: "A - 2/UDP", port: 2, proto: "UDP" }]);
    const out = await runPowerShell(rulesLoop("Write-Output $r.name"), { SKALI_RULES: two });
    expect(out.split(/\r?\n/).filter(Boolean)).toEqual(["A - 1/UDP", "A - 2/UDP"]);
    const one = JSON.stringify([{ name: "B - 1/UDP", port: 1, proto: "UDP" }]);
    expect((await runPowerShell(rulesLoop("Write-Output $r.name"), { SKALI_RULES: one })).trim()).toBe("B - 1/UDP");
    expect(await runPowerShell(rulesLoop("Write-Output $r.name"), { SKALI_RULES: "[]" })).toBe("");
  });
  it("a mid-script error aborts the script and rejects with the message", async () => {
    await expect(runPowerShell("throw 'boom'\nWrite-Output after")).rejects.toThrow(/boom/);
    await expect(runPowerShell("exit 3")).rejects.toThrow();
  });
  it("refuses env names without the SKALI_ prefix and oversized scripts", async () => {
    await expect(runPowerShell("1", { PATH: "x" })).rejects.toThrow(/SKALI_/);
    await expect(runPowerShell("# " + "x".repeat(20000))).rejects.toThrow(/too large/);
  });
});
