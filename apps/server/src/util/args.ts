/** Splits on whitespace; double quotes group; `\"` is a literal quote. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === '"') {
      cur += '"';
      has = true;
      i++;
    } else if (c === '"') {
      inQuote = !inQuote;
      has = true;
    } else if (!inQuote && /\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}
