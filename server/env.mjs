import fs from "node:fs";
import path from "node:path";
import { PUBLIC_PROVIDERS, getPublicProviderCatalog } from "./catalog.mjs";

export { PUBLIC_PROVIDERS, getPublicProviderCatalog };

/**
 * Loads environment variables from a `.env` file without overwriting existing
 * `process.env` values.
 */
export function loadEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf8");
  const loaded = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded[key] = val;
    }
  }
  return loaded;
}
