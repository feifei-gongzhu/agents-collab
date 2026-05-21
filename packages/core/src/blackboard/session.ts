/**
 * Session persistence — disk format for resume.
 *
 * The orchestrator writes session.json after every round so a crash or
 * deliberate stop never loses progress. SessionStore owns the file format
 * and migrations; the orchestrator and CLI both use it.
 *
 * Forward-compat: unknown fields are preserved on read/write so older
 * binaries don't strip data added by newer ones.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { SessionLayout } from "./layout.js";

export const SESSION_SCHEMA_VERSION = 1;

export type SessionStatus = "running" | "paused" | "finished" | "aborted";

export interface SessionRecord {
  schemaVersion: number;
  sessionId: string;
  groupId: string;
  groupSourcePath: string;
  initialPrompt: string;
  status: SessionStatus;
  /** Reason that finished/aborted the run, if any. */
  finishReason?: "consensus" | "max-rounds" | "no-speaker" | "aborted";
  /** Round number that will run NEXT. After 3 rounds completed, nextRound = 4. */
  nextRound: number;
  maxRounds: number;
  lastSpeakerId?: string;
  consensusAgentId?: string;
  /** ISO timestamps. */
  startedAt: string;
  updatedAt: string;
  /** Lightweight history (agentId + round). Full text lives in turn-log files. */
  history: { round: number; agentId: string }[];
  /** Pass-through extras for forward compatibility. */
  extra?: Record<string, unknown>;
}

export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export class SessionStore {
  constructor(readonly layout: SessionLayout) {}

  exists(): boolean {
    return existsSync(this.layout.sessionMetaFile);
  }

  async read(): Promise<SessionRecord> {
    const path = this.layout.sessionMetaFile;
    if (!existsSync(path)) {
      throw new SessionStoreError(`session.json not found: ${path}`);
    }
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SessionStoreError(`invalid JSON in ${path}: ${(err as Error).message}`);
    }
    return migrate(parsed as Partial<SessionRecord>, path);
  }

  async write(record: SessionRecord): Promise<void> {
    const data = JSON.stringify(record, null, 2) + "\n";
    await writeFile(this.layout.sessionMetaFile, data, "utf8");
  }

  /** Convenience: read or return null instead of throwing. */
  async tryRead(): Promise<SessionRecord | null> {
    if (!this.exists()) return null;
    return this.read();
  }
}

function migrate(input: Partial<SessionRecord>, sourcePath: string): SessionRecord {
  if (!input || typeof input !== "object") {
    throw new SessionStoreError(`session record not an object: ${sourcePath}`);
  }
  const ver = typeof input.schemaVersion === "number" ? input.schemaVersion : 0;
  if (ver > SESSION_SCHEMA_VERSION) {
    throw new SessionStoreError(
      `session.json schema v${ver} newer than supported v${SESSION_SCHEMA_VERSION}`,
    );
  }

  const required: (keyof SessionRecord)[] = [
    "sessionId",
    "groupId",
    "groupSourcePath",
    "initialPrompt",
    "status",
    "nextRound",
    "maxRounds",
    "startedAt",
    "updatedAt",
  ];
  for (const k of required) {
    if (input[k] === undefined || input[k] === null) {
      throw new SessionStoreError(`session.json missing field "${String(k)}" in ${sourcePath}`);
    }
  }

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: input.sessionId as string,
    groupId: input.groupId as string,
    groupSourcePath: input.groupSourcePath as string,
    initialPrompt: input.initialPrompt as string,
    status: input.status as SessionStatus,
    finishReason: input.finishReason,
    nextRound: input.nextRound as number,
    maxRounds: input.maxRounds as number,
    lastSpeakerId: input.lastSpeakerId,
    consensusAgentId: input.consensusAgentId,
    startedAt: input.startedAt as string,
    updatedAt: input.updatedAt as string,
    history: Array.isArray(input.history) ? input.history : [],
    extra: input.extra,
  };
}
