/**
 * Three scheduling strategies:
 *   - round-robin: cycles through the agent list in order
 *   - moderator:   delegates next-speaker pick to the moderator agent each round
 *   - free:        agents may "@-mention" the next speaker; falls back to round-robin
 *
 * Each strategy is a stateless function that returns the next agent id given
 * the current state. The orchestrator decides when to consult the strategy.
 */

import type { LoadedAgentConfig } from "../runtime/config.js";
import type { LoadedGroupConfig } from "./group.js";

export interface SchedulingState {
  /** Round counter, starting at 1. */
  round: number;
  /** Agent who just finished speaking (undefined before round 1). */
  lastSpeakerId?: string;
  /** Most recent speech text — strategies may inspect this. */
  lastSpeechText?: string;
  /** Full speaker history. */
  history: { round: number; agentId: string; text: string }[];
}

export type Scheduler = (
  group: LoadedGroupConfig,
  state: SchedulingState,
) => Promise<string | null>;

/** Plain rotation through group.agents, skipping a moderator if mode says so. */
export const roundRobinScheduler: Scheduler = async (group, state) => {
  const speakers = speakersExcludingModerator(group);
  if (speakers.length === 0) return null;
  if (!state.lastSpeakerId) return speakers[0]!.id;
  const idx = speakers.findIndex((a) => a.id === state.lastSpeakerId);
  return speakers[(idx + 1) % speakers.length]!.id;
};

/**
 * @-mention scheduler. Looks for the most recent "@<id>" in lastSpeechText
 * matching one of the (non-moderator) agents. Falls back to round-robin.
 */
export const freeScheduler: Scheduler = async (group, state) => {
  const speakers = speakersExcludingModerator(group);
  if (state.lastSpeechText) {
    const re = /@([A-Za-z0-9._-]+)/g;
    let m: RegExpExecArray | null;
    let last: string | undefined;
    while ((m = re.exec(state.lastSpeechText)) !== null) last = m[1];
    if (last && speakers.some((a) => a.id === last)) {
      // Don't immediately re-pick the same speaker.
      if (last !== state.lastSpeakerId) return last;
    }
  }
  return roundRobinScheduler(group, state);
};

function speakersExcludingModerator(group: LoadedGroupConfig): LoadedAgentConfig[] {
  if (group.mode !== "moderator") return group.agents;
  return group.agents.filter((a) => a.id !== group.moderatorId);
}

export { speakersExcludingModerator };
