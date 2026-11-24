import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const lib = path.resolve(__dirname, '../../../scripts/lib/service-settings.ps1');

// Runs Get-AllowlistEntry on text built by a PowerShell expression (keeps NUL/BOM/CR exact).
function entry(textExpr: string): string {
  const cmd = `. '${lib}'; Write-Output (Get-AllowlistEntry (${textExpr}))`;
  return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
}

describe.skipIf(process.platform !== 'win32')('Get-AllowlistEntry', () => {
  const want = 'SKALI_INITIAL_ALLOWLIST=192.168.0.150,10.0.0.0/24';
  it('finds the entry among several', () => {
    expect(entry(`"NODE_ENV=production\`nSKALI_PORT=4200\`n${want}\`nOTHER=1"`)).toBe(want);
  });
  it('handles CRLF', () => {
    expect(entry(`"NODE_ENV=production\`r\`n${want}\`r\`n"`)).toBe(want);
  });
  it('handles a BOM', () => {
    expect(entry(`[string][char]0xFEFF + "${want}"`)).toBe(want);
  });
  it('handles UTF-16 read as ANSI (NUL-interleaved)', () => {
    expect(entry(`("NODE_ENV=production\`n${want}\`n".ToCharArray() | ForEach-Object { [string]$_ + [string][char]0 }) -join ''`)).toBe(want);
  });
  it('returns empty when absent', () => {
    expect(entry(`"NODE_ENV=production\`nSKALI_PORT=4200"`)).toBe('');
  });
});
