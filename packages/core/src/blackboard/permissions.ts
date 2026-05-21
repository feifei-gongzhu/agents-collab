/**
 * Write permission decisions for blackboard / private files.
 *
 * Rules (from project design):
 *   - Agent writes its own agent-<id>.md or agents/<id>/** -> allow.
 *   - Agent writes another agent's area -> APPROVAL (user must agree).
 *   - Agent writes _meta.md -> deny (user-only background).
 *   - Agent writes _shared.md -> approval (only user / moderator should normally write).
 *   - Agent writes turns/* or session.json -> deny (orchestrator only).
 *   - Anything outside the session root -> deny.
 *   - Special actor "user" can write anything inside the session.
 *   - Special actor "orchestrator" can write _shared.md, turns/*, session.json,
 *     plus _meta.md when the user delegates that. Agent areas still need approval.
 */

import type { SessionLayout } from "./layout.js";
import type { PermissionContext, WriteDecision } from "./types.js";

export const USER_ACTOR = "user";
export const ORCHESTRATOR_ACTOR = "orchestrator";

export function decideWrite(
  layout: SessionLayout,
  ctx: PermissionContext,
): WriteDecision {
  const cls = layout.classify(ctx.targetPath);

  if (cls.role === "outside") {
    return {
      kind: "deny",
      reason: `path is outside the session root (${layout.root})`,
    };
  }

  // The human user is allowed everywhere inside the session.
  if (ctx.actor === USER_ACTOR) {
    return { kind: "allow", reason: "user has full access inside the session" };
  }

  // Orchestrator owns turn logs, session metadata, and the shared scratchpad.
  if (ctx.actor === ORCHESTRATOR_ACTOR) {
    switch (cls.role) {
      case "turn-log":
      case "session-meta":
      case "shared":
        return { kind: "allow", reason: `orchestrator writes its own ${cls.role}` };
      case "meta":
        return {
          kind: "approval",
          reason: "_meta.md is user-owned; ask before letting orchestrator write",
        };
      case "agent-area":
        return {
          kind: "approval",
          reason: `orchestrator wants to edit agent-${cls.ownerAgentId} area`,
        };
      case "private":
        return {
          kind: "approval",
          reason: `orchestrator wants to write inside agent ${cls.ownerAgentId}'s private dir`,
        };
    }
  }

  // Regular agents.
  switch (cls.role) {
    case "meta":
      return {
        kind: "deny",
        reason: "_meta.md is user-only background; agents must not edit it",
      };
    case "session-meta":
      return {
        kind: "deny",
        reason: "session.json is orchestrator-managed",
      };
    case "turn-log":
      return {
        kind: "deny",
        reason: "turn logs are append-only by the orchestrator",
      };
    case "shared":
      return {
        kind: "approval",
        reason: "_shared.md is the public scratchpad; user approval required",
      };
    case "agent-area":
      if (cls.ownerAgentId === ctx.actor) {
        return { kind: "allow", reason: "agent writes its own blackboard area" };
      }
      return {
        kind: "approval",
        reason: `agent ${ctx.actor} wants to edit ${cls.ownerAgentId}'s blackboard area`,
      };
    case "private":
      if (cls.ownerAgentId === ctx.actor) {
        return { kind: "allow", reason: "agent writes inside its own private cwd" };
      }
      return {
        kind: "approval",
        reason: `agent ${ctx.actor} wants to write inside ${cls.ownerAgentId}'s private dir`,
      };
  }
}

/** Convenience: just the boolean for read access. Reads are always allowed
 *  inside the session root for any agent / orchestrator / user. */
export function canRead(layout: SessionLayout, targetPath: string): boolean {
  const cls = layout.classify(targetPath);
  return cls.role !== "outside";
}
