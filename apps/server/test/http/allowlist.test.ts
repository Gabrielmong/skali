import { describe, expect, it } from "vitest";
import { isAllowed, isAllowedHost, isAllowedOrigin, isValidAllowEntry, normalizeRemote } from "../../src/http/allowlist.js";

describe("isValidAllowEntry", () => {
  it("accepts IPv4 and CIDR /0-/32", () => {
    for (const s of ["192.168.0.150", "0.0.0.0/0", "10.0.0.0/8", "192.168.0.1/32"]) expect(isValidAllowEntry(s)).toBe(true);
  });
  it("rejects junk", () => {
    for (const s of ["", "192.168.0", "192.168.0.256", "1.2.3.4/33", "1.2.3.4/", " 1.2.3.4", "01.2.3.4", "::1", "a.b.c.d", "1.2.3.4/8/1"])
      expect(isValidAllowEntry(s)).toBe(false);
  });
});

describe("isAllowed", () => {
  it("maps IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeRemote("::ffff:192.168.0.150")).toBe("192.168.0.150");
    expect(isAllowed("::ffff:192.168.0.150", ["192.168.0.150"])).toBe(true);
    expect(isAllowed("::FFFF:192.168.0.150", ["192.168.0.150"])).toBe(true);
  });
  it("matches CIDR ranges", () => {
    expect(isAllowed("192.168.0.77", ["192.168.0.0/24"])).toBe(true);
    expect(isAllowed("192.168.1.77", ["192.168.0.0/24"])).toBe(false);
    expect(isAllowed("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    expect(isAllowed("192.168.0.151", ["192.168.0.150/32"])).toBe(false);
  });
  it("denies addresses not on the list", () => {
    expect(isAllowed("10.0.0.1", ["192.168.0.150", "192.168.0.0/24"])).toBe(false);
    expect(isAllowed("192.168.0.150", [])).toBe(false);
  });
  it("always allows loopback", () => {
    expect(isAllowed("127.0.0.1", [])).toBe(true);
    expect(isAllowed("::1", [])).toBe(true);
    expect(isAllowed("::ffff:127.0.0.1", [])).toBe(true);
  });
  it("denies undefined, junk and other IPv6", () => {
    expect(isAllowed(undefined, ["0.0.0.0/0"])).toBe(false);
    expect(isAllowed("", ["0.0.0.0/0"])).toBe(false);
    expect(isAllowed("fe80::1", ["0.0.0.0/0"])).toBe(false);
    expect(isAllowed("not-an-ip", ["0.0.0.0/0"])).toBe(false);
  });
  it("ignores invalid list entries", () => {
    expect(isAllowed("10.0.0.1", ["10.0.0.1/99", "garbage"])).toBe(false);
  });
});

describe("isAllowedHost (DNS rebinding guard)", () => {
  const h = "SERVER-PC";
  it("accepts IP literals, localhost and the machine name", () => {
    for (const host of ["192.168.0.100:4200", "192.168.0.100", "127.0.0.1:4200", "[::1]:4200", "[::1]", "localhost:4200", "LOCALHOST",
      "server-pc:4200", "SERVER-PC", "server-pc.", "SERVER-PC.:4200", "localhost.", "server-pc.local:4200", "Server-PC.home.arpa",
      "server-pc.local.", "server-pc.home.arpa.:4200"])
      expect(isAllowedHost(host, h), host).toBe(true);
  });
  it("rejects other names, missing hosts and junk", () => {
    for (const host of [undefined, "", "evil.com", "evil.com:4200", "192.168.0.100.evil.com", "localhost.evil.com", "server-pc-evil.com",
      "xserver-pc", "1.2.3", "[nonsense]:4200", "server-pc:abc", "server-pc:4200:1", "server-pc..lan",
      "server-pc.attacker.com", "server-pc.attacker.com:4200", "server-pc.lan", "server-pc.lan:4200", "server-pc.evil.home",
      "x.server-pc.local", "server-pc.local.evil.com", "evil.home.arpa", "server-pc.x.home.arpa", "localhost.local", "server-pc.."])
      expect(isAllowedHost(host, h), String(host)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("allows a missing Origin and one whose host equals Host", () => {
    expect(isAllowedOrigin(undefined, "192.168.0.100:4200")).toBe(true);
    expect(isAllowedOrigin("http://192.168.0.100:4200", "192.168.0.100:4200")).toBe(true);
    expect(isAllowedOrigin("http://Server-PC:4200", "server-pc:4200")).toBe(true);
  });
  it("rejects other origins", () => {
    expect(isAllowedOrigin("http://evil.com", "192.168.0.100:4200")).toBe(false);
    expect(isAllowedOrigin("http://192.168.0.100:4201", "192.168.0.100:4200")).toBe(false);
    expect(isAllowedOrigin("null", "192.168.0.100:4200")).toBe(false);
    expect(isAllowedOrigin("http://192.168.0.100:4200", undefined)).toBe(false);
  });
});
