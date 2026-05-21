/**
 * AgentConfig — JSON-serializable description of one agent in a group.
 *
 * Lives at configs/agents/<id>.json. Loaded by the orchestrator at session start.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface AgentConfig {
  /** Stable id, used as the on-disk owner (blackboard/agent-<id>.md). */
  id: string;
  /** Display name. */
  name: string;
  /** Optional human-readable role description. */
  role?: string;
  /** ProviderRegistry id (e.g. CC-Switch UUID or jsonfile id). */
  providerId: string;
  /** Model id. If omitted, the provider's ANTHROPIC_MODEL env value is used. */
  model?: string;
  /**
   * Path to the agent's CLAUDE.md (role / persona). Resolved relative to the
   * config file's directory, or absolute. Loaded at session start and used as
   * one layer of the layered system prompt.
   */
  systemPromptFile?: string;
  /** Inline system prompt; overrides systemPromptFile when both are set. */
  systemPrompt?: string;
  /** Tool whitelist. Empty / undefined = SDK preset default. */
  allowedTools?: string[];
  /** Hard disallow list (wins over allowedTools). */
  disallowedTools?: string[];
  /** Per-call max turns inside the SDK loop. Default 8. */
  maxTurns?: number;
}

export interface LoadedAgentConfig extends AgentConfig {
  /** Resolved system prompt body (file contents merged in). */
  systemPromptText?: string;
  /** Absolute path of the config file the agent was loaded from. */
  sourcePath: string;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/** Load a single agent config from disk and resolve relative paths. */
export async function loadAgentConfig(path: string): Promise<LoadedAgentConfig> {
  if (!existsSync(path)) {
    throw new AgentConfigError(`agent config not found: ${path}`);
  }
  const raw = await readFile(path, "utf8");
  let parsed: AgentConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AgentConfigError(
      `invalid JSON in ${path}: ${(err as Error).message}`,
    );
  }
  return resolveAgentConfig(parsed, path);
}

export async function resolveAgentConfig(
  cfg: AgentConfig,
  sourcePath: string,
): Promise<LoadedAgentConfig> {
  validate(cfg, sourcePath);
  const baseDir = dirname(resolve(sourcePath));

  let systemPromptText = cfg.systemPrompt;
  if (!systemPromptText && cfg.systemPromptFile) {
    const promptPath = isAbsolute(cfg.systemPromptFile)
      ? cfg.systemPromptFile
      : resolve(baseDir, cfg.systemPromptFile);
    if (!existsSync(promptPath)) {
      throw new AgentConfigError(
        `systemPromptFile not found for agent ${cfg.id}: ${promptPath}`,
      );
    }
    systemPromptText = await readFile(promptPath, "utf8");
  }

  return {
    ...cfg,
    systemPromptText,
    sourcePath: resolve(sourcePath),
  };
}

function validate(cfg: AgentConfig, sourcePath: string) {
  if (!cfg.id || !/^[A-Za-z0-9._-]+$/.test(cfg.id)) {
    throw new AgentConfigError(
      `invalid agent id "${cfg.id}" in ${sourcePath} (allowed: A-Za-z0-9._-)`,
    );
  }
  if (!cfg.name) {
    throw new AgentConfigError(`agent ${cfg.id} missing "name" in ${sourcePath}`);
  }
  if (!cfg.providerId) {
    throw new AgentConfigError(
      `agent ${cfg.id} missing "providerId" in ${sourcePath}`,
    );
  }
}
