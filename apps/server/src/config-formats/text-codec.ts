export type TextEncoding = "utf8" | "utf8bom" | "utf16le";

export function decodeText(buf: Buffer): { text: string; encoding: TextEncoding } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString("utf16le"), encoding: "utf16le" };
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString("utf8"), encoding: "utf8bom" };
  return { text: buf.toString("utf8"), encoding: "utf8" };
}

export function encodeText(text: string, enc: TextEncoding): Buffer {
  if (enc === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  if (enc === "utf8bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  return Buffer.from(text, "utf8");
}

/** True when a non-UTF-16 buffer has a NUL byte in its first 8 KiB. */
export function isProbablyBinary(buf: Buffer): boolean {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return false;
  return buf.subarray(0, 8192).includes(0);
}
