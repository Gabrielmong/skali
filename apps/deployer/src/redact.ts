const MIN_SECRET_LENGTH = 4;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeRedactor(secrets: string[]): (line: string) => string {
  const literals = secrets
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const literalRe = literals.length > 0 ? new RegExp(literals.join('|'), 'g') : null;

  return (line) => {
    let out = literalRe ? line.replace(literalRe, '***') : line;
    out = out.replace(/github_pat_\w+/g, '***');
    out = out.replace(/gh[pousr]_\w+/g, '***');
    out = out.replace(/(Authorization:\s*)\S.*/gi, '$1***');
    return out;
  };
}
