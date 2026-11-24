import type { ConfigFormat } from "@skali/shared";
import { ConfigParseError, type ConfigDoc } from "./types.js";
import { parseIni } from "./ini.js";
import { parseJsonDoc } from "./json.js";
import { parseYamlDoc } from "./yaml.js";
import { parsePalworldConfig } from "./palworld-options.js";
import { parsePropertiesConfig } from "./properties.js";

export type { ConfigFormat };

export { ConfigParseError } from "./types.js";
export type { ConfigDoc, RawField } from "./types.js";

export function parseConfig(format: ConfigFormat, text: string): ConfigDoc {
  switch (format) {
    case "properties": return parsePropertiesConfig(text);
    case "ini": return parseIni(text);
    case "json": return parseJsonDoc(text);
    case "palworld": return parsePalworldConfig(text);
    case "yaml": return parseYamlDoc(text);
    case "raw":
      return {
        fields: () => [],
        set: () => { throw new ConfigParseError("Unknown setting"); },
        toString: () => text,
      };
    default:
      throw new ConfigParseError("Format not supported yet");
  }
}

export function detectFormat(relPath: string): ConfigFormat {
  const m = /\.([^./\\]+)$/.exec(relPath.toLowerCase());
  switch (m?.[1]) {
    case "ini": return "ini";
    case "properties": return "properties";
    case "json": return "json";
    case "yml": case "yaml": return "yaml";
    default: return "raw";
  }
}
