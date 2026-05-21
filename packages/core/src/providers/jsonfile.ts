/**
 * JSON-file provider source.
 *
 * Coexists with CC-Switch. Lets the user define providers without having
 * CC-Switch installed. File format:
 *
 * {
 *   "providers": [
 *     {
 *       "id": "local-relay",
 *       "name": "Local Relay",
 *       "env": {
 *         "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
 *         "ANTHROPIC_AUTH_TOKEN": "sk-..."
 *       },
 *       "models": ["claude-opus-4-7"]
 *     }
 *   ]
 * }
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Provider, ProviderSource } from "./types.js";

interface RawProvider {
  id: string;
  name: string;
  env: Record<string, string>;
  models?: string[];
  meta?: Record<string, unknown>;
}

interface FileShape {
  providers: RawProvider[];
}

export interface JsonFileSourceOptions {
  /** Path to the JSON file. */
  path: string;
}

export class JsonFileSource implements ProviderSource {
  readonly kind = "jsonfile" as const;
  private readonly path: string;

  constructor(opts: JsonFileSourceOptions) {
    this.path = opts.path;
  }

  isAvailable(): boolean {
    return existsSync(this.path);
  }

  async list(): Promise<Provider[]> {
    if (!this.isAvailable()) return [];

    const raw = await readFile(this.path, "utf8");
    let parsed: FileShape;
    try {
      parsed = JSON.parse(raw) as FileShape;
    } catch (err) {
      throw new Error(
        `failed to parse provider config at ${this.path}: ${(err as Error).message}`,
      );
    }
    if (!parsed?.providers || !Array.isArray(parsed.providers)) {
      throw new Error(
        `provider config at ${this.path} must have a "providers" array`,
      );
    }

    return parsed.providers
      .filter((p) => p && typeof p.id === "string" && p.env)
      .map<Provider>((p) => ({
        id: p.id,
        name: p.name ?? p.id,
        source: "jsonfile",
        env: { ...p.env },
        models: Array.isArray(p.models) ? [...p.models] : [],
        meta: p.meta,
      }));
  }
}
