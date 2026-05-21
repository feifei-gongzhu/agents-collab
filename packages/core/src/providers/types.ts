/**
 * Provider abstraction.
 *
 * A provider supplies the environment variables that the Claude Agent SDK
 * needs to reach a Claude-compatible API endpoint. Two sources are supported
 * out of the box: CC-Switch's SQLite database and a local JSON config file.
 */

export type ProviderSourceKind = "cc-switch" | "jsonfile" | "memory";

export interface Provider {
  /** Stable identifier. Stable across restarts; used in agent configs. */
  id: string;
  /** Human-readable label shown in UIs. */
  name: string;
  /** Where this provider entry came from. */
  source: ProviderSourceKind;
  /** Environment variables to inject into the agent process. Always includes
   *  ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN for Claude providers. */
  env: Record<string, string>;
  /** Models advertised by the provider (best-effort, may be empty). */
  models: string[];
  /** Provider-source-specific extras (category, notes, isCurrent, etc.). */
  meta?: Record<string, unknown>;
}

export interface ProviderSource {
  readonly kind: ProviderSourceKind;
  /** Returns providers whose env targets the Anthropic / Claude protocol. */
  list(): Promise<Provider[]>;
}

export class ProviderNotFoundError extends Error {
  constructor(id: string) {
    super(`provider not found: ${id}`);
    this.name = "ProviderNotFoundError";
  }
}
