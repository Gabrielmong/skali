/** Leaf module: shared contracts for every config format. Imports nothing from the other format files. */
export interface RawField {
  /** Opaque, unique within the doc, stable across re-parses of the same text. */
  id: string;
  key: string;
  section?: string;
  /** Decoded value. JSON keeps its type; text formats give strings. */
  value: string | number | boolean;
}

export interface ConfigDoc {
  fields(): RawField[];
  set(id: string, value: string | number | boolean): void;
  toString(): string;
}

export class ConfigParseError extends Error {
  line?: number;
  constructor(message: string, line?: number) {
    super(message);
    this.name = "ConfigParseError";
    if (line !== undefined) this.line = line;
  }
}
