import { describe, expect, it } from "vitest";
import { decodeText, encodeText, isProbablyBinary } from "../../src/config-formats/text-codec.js";

describe("text-codec", () => {
  it("utf16le with BOM decodes and re-encodes byte-identically", () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[A]\r\nk=v\r\n", "utf16le")]);
    const { text, encoding } = decodeText(buf);
    expect(encoding).toBe("utf16le");
    expect(text).toBe("[A]\r\nk=v\r\n");
    expect(encodeText(text, encoding).equals(buf)).toBe(true);
  });

  it("utf8bom round-trips; plain utf8 round-trips", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("héllo", "utf8")]);
    const a = decodeText(bom);
    expect(a.encoding).toBe("utf8bom");
    expect(a.text).toBe("héllo");
    expect(encodeText(a.text, a.encoding).equals(bom)).toBe(true);
    const plain = Buffer.from("héllo", "utf8");
    const b = decodeText(plain);
    expect(b.encoding).toBe("utf8");
    expect(encodeText(b.text, b.encoding).equals(plain)).toBe(true);
  });

  it("isProbablyBinary is true for a buffer with NUL, false for utf16le text", () => {
    expect(isProbablyBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(isProbablyBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("abc", "utf16le")]))).toBe(false);
    expect(isProbablyBinary(Buffer.from("plain text"))).toBe(false);
  });
});
