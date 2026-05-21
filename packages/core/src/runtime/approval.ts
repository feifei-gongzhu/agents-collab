/**
 * Approval interface — the bridge between the runtime's permission decisions
 * and the surface the user sees (CLI prompt / Web modal / auto-deny in tests).
 *
 * The runtime never blocks the I/O loop synchronously; it always awaits
 * the handler via Promise.
 */

import type { FileClassification } from "../blackboard/index.js";

export interface ApprovalRequest {
  /** Identifier of the agent (or "orchestrator") that wants to write. */
  actor: string;
  /** SDK tool name (e.g. "Edit", "Write", "MultiEdit"). */
  toolName: string;
  /** Tool input as the SDK reported it; useful for showing diff / path. */
  toolInput: Record<string, unknown>;
  /** Absolute path of the file being touched. */
  targetPath: string;
  /** Layout classification of the target. */
  classification: FileClassification;
  /** Why the runtime escalated to approval. */
  reason: string;
}

export interface ApprovalAllow {
  decision: "allow";
  /** Optionally rewrite the tool input before it executes. */
  updatedInput?: Record<string, unknown>;
}

export interface ApprovalDeny {
  decision: "deny";
  /** Message surfaced back to the model so it can adjust. */
  message: string;
  /** If true, the SDK aborts the run immediately. Default false. */
  interrupt?: boolean;
}

export type ApprovalResponse = ApprovalAllow | ApprovalDeny;

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalResponse>;

/** Default — used in tests / non-interactive runs. Always denies. */
export const denyAllApprovalHandler: ApprovalHandler = async (req) => ({
  decision: "deny",
  message: `auto-denied: ${req.reason}`,
});

/** Convenience for tests / trusted scripts. Always allows. */
export const allowAllApprovalHandler: ApprovalHandler = async () => ({
  decision: "allow",
});
