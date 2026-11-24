import type { PortSpec } from "@skali/shared";
import { BadRequestError } from "../errors.js";
import { NAME_RE } from "../servers/repo.js";
import { runPowerShell } from "./run.js";

const prefix = (serverName: string) => `Skali - ${serverName} - `;
const RULE_SUFFIX = /^\d{1,5}\/(UDP|TCP)$/;

export function firewallRuleName(serverName: string, p: PortSpec): string {
  return `${prefix(serverName)}${p.port}/${p.protocol.toUpperCase()}`;
}

/** Pure mirror of the PowerShell removal predicate: the rule is exactly `Skali - <name> - <port>/<PROTO>`. */
export function ruleBelongsTo(serverName: string, displayName: string): boolean {
  const pre = prefix(serverName);
  return displayName.startsWith(pre) && RULE_SUFFIX.test(displayName.slice(pre.length));
}

function checkName(serverName: string): void {
  if (typeof serverName !== "string" || !NAME_RE.test(serverName)) throw new BadRequestError("Invalid server name");
}
function checkPort(p: PortSpec): void {
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new BadRequestError(`Invalid port: ${String(p.port)}`);
  if (p.protocol !== "udp" && p.protocol !== "tcp") throw new BadRequestError("Invalid protocol");
}

// All values come from SKALI_* environment variables; no value is ever part of the script text.
// Exact prefix comparison (never -like) plus an anchored suffix, so "a" cannot match rules of server "a - b".
const REMOVE =
  "Get-NetFirewallRule -Group 'Skali' -ErrorAction SilentlyContinue | " +
  "Where-Object { $n = [string]$_.DisplayName; $n.StartsWith($env:SKALI_PREFIX, [StringComparison]::Ordinal) -and " +
  "$n.Substring($env:SKALI_PREFIX.Length) -match '^\\d{1,5}/(UDP|TCP)$' } | Remove-NetFirewallRule";
// Not `@($env:X | ConvertFrom-Json)`: on PS 5.1 the pipeline emits the whole array as ONE object.
export const rulesLoop = (body: string) =>
  `if ($env:SKALI_RULES) { $rules = ConvertFrom-Json $env:SKALI_RULES; foreach ($r in $rules) { ${body} } }`;
const CREATE = rulesLoop(
  "New-NetFirewallRule -DisplayName $r.name -Group 'Skali' -Direction Inbound -Action Allow -Protocol $r.proto -LocalPort $r.port -Profile Any | Out-Null",
);

export async function removeFirewallRules(serverName: string, run: typeof runPowerShell = runPowerShell): Promise<void> {
  checkName(serverName);
  await run(REMOVE, { SKALI_PREFIX: prefix(serverName) });
}

export async function ensureFirewallRules(serverName: string, ports: PortSpec[], run: typeof runPowerShell = runPowerShell): Promise<void> {
  checkName(serverName);
  const fwd = ports.filter((p) => p.forward);
  fwd.forEach(checkPort);
  const rules = fwd.map((p) => ({ name: firewallRuleName(serverName, p), port: p.port, proto: p.protocol.toUpperCase() }));
  await run(`${REMOVE}\n${CREATE}`, { SKALI_PREFIX: prefix(serverName), SKALI_RULES: JSON.stringify(rules) });
}
