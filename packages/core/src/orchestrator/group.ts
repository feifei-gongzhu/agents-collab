/**
 * Group definition — configuration for a multi-agent session.
 *
 * Lives at configs/groups/<id>.json. References agents by id (configs/agents/<id>.json).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { LoadedAgentConfig } from "../runtime/config.js";
import { loadAgentConfig } from "../runtime/config.js";

export type SchedulingMode = "round-robin" | "moderator" | "free";

export interface GroupConfig {
  /** Stable id, used as the session-id prefix. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional description shown in UI. */
  description?: string;
  /** Agent ids participating in the group, in order. */
  agents: string[];
  /** Where to find agent JSONs. Resolved relative to the group file. Default: ../agents */
  agentsDir?: string;
  /** Path (relative to group file) to the group-level CLAUDE.md (group background). */
  metaFile?: string;
  /** Inline group meta; overrides metaFile when both are present. */
  meta?: string;
  /** Scheduling mode. Default "round-robin". */
  mode?: SchedulingMode;
  /** Hard upper bound on rounds. Default 10. */
  maxRounds?: number;
  /** When mode = "moderator", the agent id that decides next speaker. */
  moderatorId?: string;
  /** Consensus marker. When an agent's response contains this, the run stops.
   *  Default: "[CONSENSUS:final]". */
  consensusMarker?: string;
}

export interface LoadedGroupConfig {
  id: string;
  name: string;
  description?: string;
  agents: LoadedAgentConfig[];
  /** Resolved group-level CLAUDE.md content. Empty string if none. */
  metaText: string;
  mode: SchedulingMode;
  maxRounds: number;
  moderatorId?: string;
  consensusMarker: string;
  sourcePath: string;
}

export class GroupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupConfigError";
  }
}

export async function loadGroupConfig(path: string): Promise<LoadedGroupConfig> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new GroupConfigError(`group config not found: ${abs}`);
  const raw = await readFile(abs, "utf8");
  let parsed: GroupConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GroupConfigError(`invalid JSON in ${abs}: ${(err as Error).message}`);
  }

  if (!parsed.id || !parsed.name) {
    throw new GroupConfigError(`group ${abs} requires "id" and "name"`);
  }
  if (!Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new GroupConfigError(`group ${parsed.id} needs at least 2 agents`);
  }

  const baseDir = dirname(abs);
  const agentsDir = isAbsolute(parsed.agentsDir ?? "")
    ? (parsed.agentsDir as string)
    : resolve(baseDir, parsed.agentsDir ?? "../agents");

  const agents: LoadedAgentConfig[] = [];
  for (const agentId of parsed.agents) {
    const path = resolve(agentsDir, `${agentId}.json`);
    agents.push(await loadAgentConfig(path));
  }

  // Validate moderator presence in moderator mode.
  const mode = parsed.mode ?? "round-robin";
  if (mode === "moderator") {
    if (!parsed.moderatorId) {
      throw new GroupConfigError(
        `group ${parsed.id} mode "moderator" requires "moderatorId"`,
      );
    }
    if (!agents.some((a) => a.id === parsed.moderatorId)) {
      throw new GroupConfigError(
        `moderatorId "${parsed.moderatorId}" not in agents of group ${parsed.id}`,
      );
    }
  }

  // Resolve meta text.
  let metaText = parsed.meta ?? "";
  if (!metaText && parsed.metaFile) {
    const metaPath = isAbsolute(parsed.metaFile)
      ? parsed.metaFile
      : resolve(baseDir, parsed.metaFile);
    if (!existsSync(metaPath)) {
      throw new GroupConfigError(
        `metaFile not found for group ${parsed.id}: ${metaPath}`,
      );
    }
    metaText = await readFile(metaPath, "utf8");
  }

  return {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    agents,
    metaText,
    mode,
    maxRounds: parsed.maxRounds ?? 10,
    moderatorId: parsed.moderatorId,
    consensusMarker: parsed.consensusMarker ?? "[CONSENSUS:final]",
    sourcePath: abs,
  };
}
