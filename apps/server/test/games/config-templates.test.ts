import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config-formats/doc.js";
import { basic } from "../../src/games/basic.js";
import { minecraft } from "../../src/games/minecraft.js";
import { palworld } from "../../src/games/palworld.js";
import type { ConfigTemplate } from "../../src/games/types.js";
import { valheim } from "../../src/games/valheim.js";
import { rec, tmpFolder, touch } from "./helpers.js";

const fixture = (n: string) => fs.readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");

// Template keys absent from the fixture file go here, each with a reason. Currently none.
const OPTIONAL_KEYS = new Set<string>([]);

function template(adapter: typeof palworld, id: string): ConfigTemplate {
  const t = adapter.configSources.find((x) => x.id === id)?.template;
  if (!t) throw new Error(`no template ${id}`);
  return t;
}

function changedKeys(format: "palworld" | "properties", before: string, after: string): string[] {
  const val = (t: string) => new Map(parseConfig(format, t).fields().map((f) => [f.key, f.value]));
  const a = val(before), b = val(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
}

describe("templates", () => {
  it("palworld locked keys equal the keys prepare() sets", async () => {
    const f = tmpFolder();
    const def = fixture("DefaultPalWorldSettings.ini");
    touch(path.join(f, "DefaultPalWorldSettings.ini"), def);
    // Fixture has RESTAPIEnabled=False, RESTAPIPort=8212, AdminPassword="": a different port makes all three change.
    await palworld.prepare(rec("palworld", f, { restPort: 9000 }));
    const after = fs.readFileSync(path.join(f, "Pal", "Saved", "Config", "WindowsServer", "PalWorldSettings.ini"), "utf8");
    const changed = changedKeys("palworld", def, after);
    expect(changed).toEqual(Object.keys(template(palworld, "palworld-settings").locked).sort());
  });

  it("minecraft locked keys equal the keys prepare() sets", async () => {
    const f = tmpFolder();
    const props = fixture("server.properties");
    touch(path.join(f, "eula.txt"), "eula=true\n");
    touch(path.join(f, "server.properties"), props);
    await minecraft.prepare(rec("minecraft", f, { port: 25570, rconPort: 25580 }));
    const changed = changedKeys("properties", props, fs.readFileSync(path.join(f, "server.properties"), "utf8"));
    const locked = Object.keys(template(minecraft, "server-properties").locked).sort();
    for (const k of changed) expect(locked).toContain(k);
    expect(locked).toEqual(
      ["broadcast-rcon-to-ops", "enable-rcon", "rcon.password", "rcon.port", "server-port"],
    );
  });

  it("every select field has >=2 options; every key exists in the matching fixture file", () => {
    const cases: [ConfigTemplate, "palworld" | "properties", string][] = [
      [template(palworld, "palworld-settings"), "palworld", "DefaultPalWorldSettings.ini"],
      [template(minecraft, "server-properties"), "properties", "server.properties"],
    ];
    for (const [t, format, file] of cases) {
      const keys = new Set(parseConfig(format, fixture(file)).fields().map((x) => x.key));
      for (const [k, meta] of Object.entries(t.fields)) {
        if (meta.type === "select") expect(meta.options?.length ?? 0, k).toBeGreaterThanOrEqual(2);
        if (!OPTIONAL_KEYS.has(k)) expect(keys.has(k), `${k} missing from ${file}`).toBe(true);
      }
      for (const k of Object.keys(t.locked)) expect(keys.has(k), `locked ${k}`).toBe(true);
    }
  });

  it("Skáli's own passwords are secret fields", () => {
    expect(template(palworld, "palworld-settings").fields.AdminPassword?.type).toBe("secret");
    expect(template(minecraft, "server-properties").fields["rcon.password"]?.type).toBe("secret");
  });

  it("palworld and minecraft sources match the brief", () => {
    expect(palworld.configSources.map((s) => s.id)).toEqual(["palworld-settings"]);
    expect(palworld.configSources[0]!.path).toBe("Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini");
    expect(palworld.configSources[0]!.seedFrom).toBe("DefaultPalWorldSettings.ini");
    expect(minecraft.configSources.map((s) => s.id)).toEqual(["server-properties", "ops", "whitelist"]);
  });
});

describe("adapters", () => {
  it("valheim and basic have no built-in config sources", () => {
    expect(valheim.configSources).toEqual([]);
    expect(basic.configSources).toEqual([]);
  });
});
