/**
 * Blackboard architecture types.
 *
 * Layout per session:
 *
 *   workspaces/<sessionId>/
 *     blackboard/
 *       _meta.md              # group background, user-only writable
 *       _shared.md            # public area, user + moderator writable
 *       agent-<agentId>.md    # owner-only writable, others read-only
 *       turns/                # append-only chat log, written by orchestrator
 *         <round>-<agentId>.md
 *     agents/<agentId>/       # agent private cwd, owner-only writable
 *     session.json
 */

export type FileRole =
  | "meta" // blackboard/_meta.md — user only
  | "shared" // blackboard/_shared.md — user + moderator
  | "agent-area" // blackboard/agent-<id>.md — owner only
  | "turn-log" // blackboard/turns/<n>-<id>.md — orchestrator only
  | "private" // agents/<id>/** — owner only
  | "session-meta" // session.json — orchestrator only
  | "outside"; // anything outside the session root

export interface FileClassification {
  role: FileRole;
  /** Absolute, normalized path inside the session root (or null if outside). */
  absolutePath: string;
  /** Owning agent id when role is "agent-area" or "private". */
  ownerAgentId?: string;
  /** Always within the session, relative to session root, forward-slashed. */
  relativePath?: string;
}

export type WriteDecision =
  /** Allowed without prompting (owner writing own area, etc.). */
  | { kind: "allow"; reason: string }
  /** Hard refusal — never ask the user. */
  | { kind: "deny"; reason: string }
  /** Allowed only after explicit user approval. */
  | { kind: "approval"; reason: string };

export interface PermissionContext {
  /** Agent that wants to write. Use "user" for the human, "orchestrator" for moderator. */
  actor: string;
  /** Absolute target path on disk. */
  targetPath: string;
}

export class BlackboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlackboardError";
  }
}
