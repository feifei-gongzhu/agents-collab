/**
 * Path layout helpers for a single session's blackboard + private areas.
 *
 * All filesystem paths are absolute and OS-native; the relative paths exposed
 * for classification use forward slashes so they match across Windows and POSIX.
 */

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileClassification, FileRole } from "./types.js";

const POSIX_SEP = "/";

const AGENT_AREA_RE = /^agent-([A-Za-z0-9._-]+)\.md$/;

export class SessionLayout {
  /** Absolute path of the session root: workspaces/<sessionId>/. */
  readonly root: string;
  readonly sessionId: string;

  constructor(workspacesRoot: string, sessionId: string) {
    if (!isAbsolute(workspacesRoot)) {
      throw new Error(`workspacesRoot must be absolute: ${workspacesRoot}`);
    }
    this.sessionId = sessionId;
    this.root = resolve(workspacesRoot, sessionId);
  }

  /** blackboard/ */
  get blackboardDir(): string {
    return join(this.root, "blackboard");
  }

  /** blackboard/turns/ */
  get turnsDir(): string {
    return join(this.blackboardDir, "turns");
  }

  /** agents/ — parent of all per-agent private cwds. */
  get agentsDir(): string {
    return join(this.root, "agents");
  }

  /** session.json */
  get sessionMetaFile(): string {
    return join(this.root, "session.json");
  }

  /** blackboard/_meta.md */
  get metaFile(): string {
    return join(this.blackboardDir, "_meta.md");
  }

  /** blackboard/_shared.md */
  get sharedFile(): string {
    return join(this.blackboardDir, "_shared.md");
  }

  /** blackboard/agent-<id>.md */
  agentAreaFile(agentId: string): string {
    return join(this.blackboardDir, `agent-${agentId}.md`);
  }

  /** agents/<id>/ */
  agentPrivateDir(agentId: string): string {
    return join(this.agentsDir, agentId);
  }

  /** blackboard/turns/<round>-<agentId>.md */
  turnLogFile(round: number, agentId: string): string {
    const padded = String(round).padStart(4, "0");
    return join(this.turnsDir, `${padded}-${agentId}.md`);
  }

  /**
   * Classify a path relative to this session.
   * Returns role + owner (when applicable). Paths outside the session resolve
   * to role "outside".
   */
  classify(targetPath: string): FileClassification {
    const abs = resolve(targetPath);
    const rel = relative(this.root, abs);

    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { role: "outside", absolutePath: abs };
    }

    const posixRel = rel.split(sep).join(POSIX_SEP);

    if (posixRel === "session.json") {
      return { role: "session-meta", absolutePath: abs, relativePath: posixRel };
    }
    if (posixRel === "blackboard/_meta.md") {
      return { role: "meta", absolutePath: abs, relativePath: posixRel };
    }
    if (posixRel === "blackboard/_shared.md") {
      return { role: "shared", absolutePath: abs, relativePath: posixRel };
    }
    if (posixRel.startsWith("blackboard/turns/")) {
      return { role: "turn-log", absolutePath: abs, relativePath: posixRel };
    }
    if (posixRel.startsWith("blackboard/")) {
      const tail = posixRel.slice("blackboard/".length);
      const m = AGENT_AREA_RE.exec(tail);
      if (m) {
        return {
          role: "agent-area",
          absolutePath: abs,
          relativePath: posixRel,
          ownerAgentId: m[1],
        };
      }
      // Unknown blackboard file — treat as shared for read but block writes by default.
      return { role: "shared", absolutePath: abs, relativePath: posixRel };
    }
    if (posixRel.startsWith("agents/")) {
      const parts = posixRel.split(POSIX_SEP);
      // agents/<agentId>/...
      if (parts.length >= 2 && parts[1]) {
        return {
          role: "private",
          absolutePath: abs,
          relativePath: posixRel,
          ownerAgentId: parts[1],
        };
      }
    }
    // Anything else inside the session is uncategorized.
    return { role: "outside", absolutePath: abs, relativePath: posixRel };
  }
}

/**
 * Create the on-disk skeleton (idempotent).
 *
 * Note: agent areas (agent-<id>.md) and private dirs (agents/<id>/) are created
 * on demand by ensureAgentArea() because the agent list isn't known at init.
 */
export async function ensureSessionSkeleton(layout: SessionLayout): Promise<void> {
  await mkdir(layout.blackboardDir, { recursive: true });
  await mkdir(layout.turnsDir, { recursive: true });
  await mkdir(layout.agentsDir, { recursive: true });
}

export async function ensureAgentArea(
  layout: SessionLayout,
  agentId: string,
): Promise<{ areaFile: string; privateDir: string }> {
  const areaFile = layout.agentAreaFile(agentId);
  const privateDir = layout.agentPrivateDir(agentId);
  await mkdir(dirname(areaFile), { recursive: true });
  await mkdir(privateDir, { recursive: true });
  return { areaFile, privateDir };
}

/** For tests / debugging — list role-tagged paths under the session root. */
export const FILE_ROLE_PRIORITY: FileRole[] = [
  "session-meta",
  "meta",
  "shared",
  "agent-area",
  "turn-log",
  "private",
  "outside",
];
