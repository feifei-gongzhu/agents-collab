/**
 * Composite provider registry. Merges multiple sources and de-duplicates by id.
 *
 * Earlier sources win on id collisions. The default factory wires
 * CC-Switch (if present) ahead of the local JSON file at configs/providers.json,
 * matching the user's "coexistence" requirement: prefer real CC-Switch data,
 * fall back to project-local config.
 */

import { join } from "node:path";
import { CCSwitchSource } from "./ccswitch.js";
import { JsonFileSource } from "./jsonfile.js";
import type { Provider, ProviderSource } from "./types.js";
import { ProviderNotFoundError } from "./types.js";

export * from "./types.js";
export { CCSwitchSource } from "./ccswitch.js";
export { JsonFileSource } from "./jsonfile.js";

export interface ProviderRegistryOptions {
  sources: ProviderSource[];
}

export class ProviderRegistry {
  private readonly sources: ProviderSource[];

  constructor(opts: ProviderRegistryOptions) {
    this.sources = opts.sources;
  }

  async list(): Promise<Provider[]> {
    const seen = new Set<string>();
    const out: Provider[] = [];
    for (const source of this.sources) {
      const items = await source.list();
      for (const p of items) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        out.push(p);
      }
    }
    return out;
  }

  async get(id: string): Promise<Provider> {
    const all = await this.list();
    const byId = all.find((p) => p.id === id);
    if (byId) return byId;
    // Fallback: agent configs often reference providers by human-readable name
    // (e.g. "ikunn") rather than CC-Switch UUID. Match by name as a second pass.
    const byName = all.find((p) => p.name === id);
    if (byName) return byName;
    throw new ProviderNotFoundError(id);
  }
}

export interface DefaultRegistryOptions {
  /** Project root — used to locate configs/providers.json. */
  projectRoot: string;
  /** Override CC-Switch DB path (mostly for tests). */
  ccSwitchDbPath?: string;
}

/**
 * Build the standard registry: CC-Switch first, JSON fallback second.
 * Both sources are optional — missing files are silently skipped.
 */
export function createDefaultRegistry(
  opts: DefaultRegistryOptions,
): ProviderRegistry {
  return new ProviderRegistry({
    sources: [
      new CCSwitchSource({ dbPath: opts.ccSwitchDbPath }),
      new JsonFileSource({
        path: join(opts.projectRoot, "configs", "providers.json"),
      }),
    ],
  });
}
