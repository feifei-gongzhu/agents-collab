/**
 * CC-Switch SQLite source.
 *
 * Reads ~/.cc-switch/cc-switch.db (read-only) and exposes claude providers.
 * Layout reverse-engineered from cc-switch v3.12: providers table with
 * settings_config JSON shaped as { "env": { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ... } }.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderSource } from "./types.js";

const DEFAULT_DB_PATH = join(homedir(), ".cc-switch", "cc-switch.db");

const MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_REASONING_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;

interface RawRow {
  id: string;
  name: string;
  settings_config: string;
  category: string | null;
  is_current: number;
  notes: string | null;
  website_url: string | null;
  sort_index: number | null;
}

export interface CCSwitchSourceOptions {
  /** Override DB path. Defaults to ~/.cc-switch/cc-switch.db. */
  dbPath?: string;
}

export class CCSwitchSource implements ProviderSource {
  readonly kind = "cc-switch" as const;
  private readonly dbPath: string;

  constructor(opts: CCSwitchSourceOptions = {}) {
    this.dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  }

  /** True if a CC-Switch database exists at the configured location. */
  isAvailable(): boolean {
    return existsSync(this.dbPath);
  }

  async list(): Promise<Provider[]> {
    if (!this.isAvailable()) return [];

    // node:sqlite is experimental in Node 22/24 but stable enough for read-only use.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, name, settings_config, category, is_current, notes, website_url, sort_index
             FROM providers
            WHERE app_type = 'claude'
            ORDER BY COALESCE(sort_index, 9999), name`,
        )
        .all() as unknown as RawRow[];

      return rows.flatMap((row) => parseRow(row));
    } finally {
      db.close();
    }
  }
}

function parseRow(row: RawRow): Provider[] {
  let cfg: { env?: Record<string, string> } = {};
  try {
    cfg = JSON.parse(row.settings_config);
  } catch {
    return [];
  }
  const env = cfg.env ?? {};
  if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) {
    // Skip providers that aren't usable as Claude endpoints.
    return [];
  }

  const models = uniq(
    MODEL_ENV_KEYS.map((k) => env[k]).filter((v): v is string => Boolean(v)),
  );

  return [
    {
      id: row.id,
      name: row.name,
      source: "cc-switch",
      env: { ...env },
      models,
      meta: {
        category: row.category,
        isCurrent: Boolean(row.is_current),
        notes: row.notes,
        websiteUrl: row.website_url,
      },
    },
  ];
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
