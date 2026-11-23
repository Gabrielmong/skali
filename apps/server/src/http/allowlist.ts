const OCTET = /^(0|[1-9]\d{0,2})$/;
const PREFIX = /^(0|[1-9]\d?)$/;

/** Strict IPv4 address or IPv4 CIDR (/0-/32); no whitespace or other junk. */
export function isValidAllowEntry(s: string): boolean {
  const [addr, prefix, ...rest] = s.split("/");
  if (rest.length > 0) return false;
  if (prefix !== undefined && !(PREFIX.test(prefix) && Number(prefix) <= 32)) return false;
  const parts = addr.split(".");
  return parts.length === 4 && parts.every((p) => OCTET.test(p) && Number(p) <= 255);
}
