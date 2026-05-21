/**
 * Blackboard read/write helpers built on top of SessionLayout + decideWrite.
 *
 * Append semantics: agents always write their *own* areas via appendToOwnArea
 * which guards against accidental cross-writes. Direct writes that need user
 * approval are NOT done here — the agent runtime (canUseTool hook) handles
 * those interactively.
 */

import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ensureAgentArea, SessionLayout } from "./layout.js";
import { BlackboardError } from "./types.js";

export interface AppendOptions {
  /** Optional header inserted before the body (e.g. "## Round 3 — recon"). */
  header?: string;
  /** Append a trailing blank line. Default true. */
  trailingBlankLine?: boolean;
}

export class Blackboard {
  constructor(readonly layout: SessionLayout) {}

  /** Append to the agent's own blackboard area. Creates the file on first call. */
  async appendToOwnArea(
    agentId: string,
    body: string,
    opts: AppendOptions = {},
  ): Promise<string> {
    const { areaFile } = await ensureAgentArea(this.layout, agentId);
    const chunk = formatChunk(body, opts);
    await appendFile(areaFile, chunk, "utf8");
    return areaFile;
  }

  /** Read another agent's area (or your own). Returns "" if missing. */
  async readAgentArea(agentId: string): Promise<string> {
    const file = this.layout.agentAreaFile(agentId);
    if (!existsSync(file)) return "";
    return readFile(file, "utf8");
  }

  /** Read the user-authored group background. */
  async readMeta(): Promise<string> {
    if (!existsSync(this.layout.metaFile)) return "";
    return readFile(this.layout.metaFile, "utf8");
  }

  /** Write the user-authored group background. Caller must verify the actor is "user". */
  async writeMeta(content: string): Promise<void> {
    await writeFile(this.layout.metaFile, content, "utf8");
  }

  /** Append to the public scratchpad. */
  async appendShared(body: string, opts: AppendOptions = {}): Promise<void> {
    await appendFile(this.layout.sharedFile, formatChunk(body, opts), "utf8");
  }

  async readShared(): Promise<string> {
    if (!existsSync(this.layout.sharedFile)) return "";
    return readFile(this.layout.sharedFile, "utf8");
  }

  /** Append a turn log entry. Used by orchestrator after each agent speaks. */
  async appendTurn(round: number, agentId: string, body: string): Promise<string> {
    const file = this.layout.turnLogFile(round, agentId);
    const chunk = formatChunk(body, {
      header: `## Round ${round} — ${agentId}`,
      trailingBlankLine: true,
    });
    await writeFile(file, chunk, "utf8");
    return file;
  }

  /** Discover all agent ids that already have an area file. */
  async listAgentAreas(): Promise<string[]> {
    if (!existsSync(this.layout.blackboardDir)) return [];
    const entries = await readdir(this.layout.blackboardDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /^agent-.+\.md$/.test(e.name))
      .map((e) => e.name.replace(/^agent-/, "").replace(/\.md$/, ""));
  }

  /** Snapshot of all turn log files in chronological order. */
  async listTurnFiles(): Promise<string[]> {
    if (!existsSync(this.layout.turnsDir)) return [];
    const entries = await readdir(this.layout.turnsDir);
    return entries.filter((n) => n.endsWith(".md")).sort();
  }
}

function formatChunk(body: string, opts: AppendOptions): string {
  const trailing = opts.trailingBlankLine ?? true;
  const head = opts.header ? `${opts.header}\n\n` : "";
  const tail = trailing ? "\n\n" : "";
  if (!body && !head) {
    throw new BlackboardError("refusing to append empty content with no header");
  }
  return `${head}${body.replace(/\s*$/, "")}\n${tail}`;
}
