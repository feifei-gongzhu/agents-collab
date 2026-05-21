/**
 * Orchestrator — drives the multi-agent run loop.
 *
 * Responsibilities:
 *   - Pick the next speaker via a Scheduler (round-robin / free / moderator)
 *   - Compose the per-turn prompt (initial task on round 1, continuation after)
 *   - Spin up an AgentRuntime per turn with the group's meta layered in
 *   - Persist the turn to the blackboard via Blackboard.appendTurn
 *   - Stop on consensus marker or maxRounds
 *
 * The orchestrator is intentionally state-light: SchedulingState lives only in
 * memory, while turn artifacts live on disk under the session layout. Resume
 * (Task #5) will hydrate state from those artifacts.
 */

import {
  Blackboard,
  ensureSessionSkeleton,
  SessionStore,
  type SessionLayout,
  type SessionRecord,
  SESSION_SCHEMA_VERSION,
} from "../blackboard/index.js";
import type { Provider } from "../providers/index.js";
import { AgentRuntime } from "../runtime/index.js";
import type { ApprovalHandler, LoadedAgentConfig } from "../runtime/index.js";
import type { LoadedGroupConfig } from "./group.js";
import {
  freeScheduler,
  roundRobinScheduler,
  speakersExcludingModerator,
  type Scheduler,
  type SchedulingState,
} from "./schedulers.js";

export type ProviderResolver = (providerId: string) => Promise<Provider>;

/** Minimal runtime contract used by the orchestrator. */
export interface AgentRuntimeLike {
  run(opts: { prompt: string; signal?: AbortSignal }): Promise<{ text: string }>;
}

export interface RuntimeFactoryArgs {
  agent: LoadedAgentConfig;
  provider: Provider;
  layout: SessionLayout;
  approvalHandler?: ApprovalHandler;
  extraSystemPromptLayers: string[];
}

export type RuntimeFactory = (args: RuntimeFactoryArgs) => AgentRuntimeLike;

export interface OrchestratorOptions {
  group: LoadedGroupConfig;
  layout: SessionLayout;
  /** Resolves provider config by id (usually backed by ProviderRegistry). */
  providerResolver: ProviderResolver;
  /** Forwarded to every AgentRuntime created by the orchestrator. */
  approvalHandler?: ApprovalHandler;
  /**
   * Custom picker for moderator-mode. If omitted, the orchestrator runs the
   * moderator agent with a tightly-scoped prompt and parses its reply.
   */
  moderatorPicker?: ModeratorPicker;
  /** Override the maxRounds in the group config (e.g. CLI flag). */
  maxRoundsOverride?: number;
  /** Test seam — produces an AgentRuntime-compatible runner. */
  runtimeFactory?: RuntimeFactory;
}

export type ModeratorPicker = (ctx: {
  group: LoadedGroupConfig;
  state: SchedulingState;
  moderator: LoadedAgentConfig;
  runModerator: (prompt: string) => Promise<string>;
}) => Promise<string | null>;

export type FinishReason = "consensus" | "max-rounds" | "no-speaker" | "aborted";

export interface OrchestratorEvent {
  type:
    | "run-start"
    | "round-start"
    | "agent-speaking"
    | "agent-spoke"
    | "consensus-reached"
    | "run-finished";
  round?: number;
  agentId?: string;
  text?: string;
  reason?: FinishReason;
}

export interface OrchestratorRunOptions {
  /** Task prompt sent to the first speaker. */
  initialPrompt: string;
  signal?: AbortSignal;
  onEvent?: (e: OrchestratorEvent) => void;
  /**
   * When provided, the run starts from this saved record (resume).
   * Caller is responsible for matching the group/initialPrompt; mismatches
   * are rejected.
   */
  resumeFrom?: SessionRecord;
}

export interface OrchestratorRunResult {
  reason: FinishReason;
  rounds: number;
  history: SchedulingState["history"];
  /** Set when finish reason is "consensus". */
  consensusAgentId?: string;
}

export class Orchestrator {
  readonly group: LoadedGroupConfig;
  readonly layout: SessionLayout;
  readonly blackboard: Blackboard;
  readonly sessionStore: SessionStore;
  private readonly providerResolver: ProviderResolver;
  private readonly approvalHandler?: ApprovalHandler;
  private readonly moderatorPicker?: ModeratorPicker;
  private readonly maxRounds: number;
  private readonly runtimeFactory: RuntimeFactory;

  constructor(opts: OrchestratorOptions) {
    this.group = opts.group;
    this.layout = opts.layout;
    this.blackboard = new Blackboard(opts.layout);
    this.sessionStore = new SessionStore(opts.layout);
    this.providerResolver = opts.providerResolver;
    this.approvalHandler = opts.approvalHandler;
    this.moderatorPicker = opts.moderatorPicker;
    this.maxRounds = opts.maxRoundsOverride ?? opts.group.maxRounds;
    this.runtimeFactory =
      opts.runtimeFactory ??
      ((a) =>
        new AgentRuntime({
          agent: a.agent,
          provider: a.provider,
          layout: a.layout,
          approvalHandler: a.approvalHandler,
          extraSystemPromptLayers: a.extraSystemPromptLayers,
        }));
  }

  /** Public entry: run the loop until consensus / maxRounds / abort. */
  async run(opts: OrchestratorRunOptions): Promise<OrchestratorRunResult> {
    await ensureSessionSkeleton(this.layout);

    // Lay down group meta into blackboard/_meta.md once. Caller-supplied
    // metaText wins over an existing file (caller is the source of truth).
    if (this.group.metaText) {
      await this.blackboard.writeMeta(this.group.metaText);
    }

    const startedAt = opts.resumeFrom?.startedAt ?? new Date().toISOString();
    const state: SchedulingState = await this.hydrateState(opts.resumeFrom);
    const emit = (e: OrchestratorEvent) => opts.onEvent?.(e);
    emit({ type: "run-start" });

    let consensusAgentId = opts.resumeFrom?.consensusAgentId;
    let reason: FinishReason | undefined =
      opts.resumeFrom?.status === "finished" || opts.resumeFrom?.status === "aborted"
        ? opts.resumeFrom.finishReason ?? "max-rounds"
        : undefined;

    // If we resumed a record that was already finished, just persist + return.
    if (reason) {
      await this.persist({
        startedAt,
        initialPrompt: opts.initialPrompt,
        state,
        status: opts.resumeFrom!.status,
        finishReason: reason,
        consensusAgentId,
      });
      emit({ type: "run-finished", reason, round: state.round });
      return {
        reason,
        rounds: state.history.length,
        history: state.history,
        consensusAgentId,
      };
    }

    while (state.round <= this.maxRounds) {
      if (opts.signal?.aborted) {
        reason = "aborted";
        break;
      }

      emit({ type: "round-start", round: state.round });

      const speakerId = await this.pickNextSpeaker(state, opts.signal);
      if (!speakerId) {
        reason = "no-speaker";
        break;
      }

      emit({ type: "agent-speaking", round: state.round, agentId: speakerId });

      const turnPrompt = this.composeTurnPrompt(state, opts.initialPrompt);
      const text = await this.runOneTurn(speakerId, turnPrompt, opts.signal);

      await this.blackboard.appendTurn(state.round, speakerId, text);
      await this.blackboard.appendToOwnArea(speakerId, text, {
        header: `## Round ${state.round}`,
      });

      state.lastSpeakerId = speakerId;
      state.lastSpeechText = text;
      state.history.push({ round: state.round, agentId: speakerId, text });

      emit({ type: "agent-spoke", round: state.round, agentId: speakerId, text });

      let stopHere = false;
      if (this.containsConsensus(text)) {
        consensusAgentId = speakerId;
        reason = "consensus";
        stopHere = true;
      }

      // Persist after every round so a crash won't lose progress.
      await this.persist({
        startedAt,
        initialPrompt: opts.initialPrompt,
        state,
        status: stopHere ? "finished" : "running",
        finishReason: stopHere ? reason : undefined,
        consensusAgentId,
      });

      if (stopHere) {
        emit({ type: "consensus-reached", round: state.round, agentId: speakerId });
        break;
      }

      state.round += 1;
    }

    if (!reason) reason = "max-rounds";
    const finalStatus = reason === "aborted" ? "aborted" : "finished";
    await this.persist({
      startedAt,
      initialPrompt: opts.initialPrompt,
      state,
      status: finalStatus,
      finishReason: reason,
      consensusAgentId,
    });
    emit({ type: "run-finished", reason, round: state.round });

    return {
      reason,
      rounds: state.history.length,
      history: state.history,
      consensusAgentId,
    };
  }

  // ----- internals ----------------------------------------------------------

  private async hydrateState(record: SessionRecord | undefined): Promise<SchedulingState> {
    if (!record) return { round: 1, history: [] };

    if (record.groupId !== this.group.id) {
      throw new Error(
        `resume: session.json group "${record.groupId}" != current group "${this.group.id}"`,
      );
    }

    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");

    // Walk the disk record. Re-read each turn-log file so lastSpeechText is
    // accurate for free-mode @-mention scheduling.
    const history: SchedulingState["history"] = [];
    for (const h of record.history) {
      const file = this.layout.turnLogFile(h.round, h.agentId);
      let text = "";
      if (existsSync(file)) {
        try {
          text = await readFile(file, "utf8");
        } catch {
          text = "";
        }
      }
      history.push({ round: h.round, agentId: h.agentId, text });
    }

    const last = history[history.length - 1];
    return {
      round: record.nextRound,
      history,
      lastSpeakerId: record.lastSpeakerId ?? last?.agentId,
      lastSpeechText: last?.text,
    };
  }

  private async persist(args: {
    startedAt: string;
    initialPrompt: string;
    state: SchedulingState;
    status: "running" | "finished" | "aborted" | "paused";
    finishReason?: FinishReason;
    consensusAgentId?: string;
  }): Promise<void> {
    const record: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: this.layout.sessionId,
      groupId: this.group.id,
      groupSourcePath: this.group.sourcePath,
      initialPrompt: args.initialPrompt,
      status: args.status,
      finishReason: args.finishReason,
      nextRound:
        args.status === "running" ? args.state.round + 1 : args.state.round,
      maxRounds: this.maxRounds,
      lastSpeakerId: args.state.lastSpeakerId,
      consensusAgentId: args.consensusAgentId,
      startedAt: args.startedAt,
      updatedAt: new Date().toISOString(),
      history: args.state.history.map((h) => ({ round: h.round, agentId: h.agentId })),
    };
    await this.sessionStore.write(record);
  }

  private async pickNextSpeaker(
    state: SchedulingState,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    if (this.group.mode === "moderator") {
      return this.pickViaModerator(state, signal);
    }
    const scheduler: Scheduler =
      this.group.mode === "free" ? freeScheduler : roundRobinScheduler;
    return scheduler(this.group, state);
  }

  private async pickViaModerator(
    state: SchedulingState,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const moderator = this.group.agents.find((a) => a.id === this.group.moderatorId);
    if (!moderator) {
      // Should have been caught by loadGroupConfig, but be defensive.
      return roundRobinScheduler(this.group, state);
    }

    const speakers = speakersExcludingModerator(this.group);
    if (speakers.length === 0) return null;

    // Custom picker takes precedence if supplied.
    if (this.moderatorPicker) {
      const runModerator = (prompt: string) => this.runOneTurn(moderator.id, prompt, signal);
      const id = await this.moderatorPicker({
        group: this.group,
        state,
        moderator,
        runModerator,
      });
      if (id && speakers.some((a) => a.id === id)) return id;
      return roundRobinScheduler(this.group, state);
    }

    // Default: ask moderator with a tightly-scoped prompt.
    const candidates = speakers.map((a) => `- ${a.id} (${a.name})`).join("\n");
    const lastBlock = state.lastSpeakerId
      ? `Round ${state.round - 1} spoken by ${state.lastSpeakerId}:\n${truncate(
          state.lastSpeechText ?? "",
          1200,
        )}`
      : "(no prior speakers)";

    const prompt = [
      `You are the moderator of group "${this.group.name}".`,
      `Pick the next speaker for round ${state.round}.`,
      "",
      "Candidates:",
      candidates,
      "",
      "Recent context:",
      lastBlock,
      "",
      "Reply with ONLY the chosen agent id, nothing else.",
    ].join("\n");

    const reply = await this.runOneTurn(moderator.id, prompt, signal);
    const chosen = extractAgentId(reply, speakers.map((a) => a.id));
    if (chosen) return chosen;
    return roundRobinScheduler(this.group, state);
  }

  private composeTurnPrompt(state: SchedulingState, initialPrompt: string): string {
    if (state.round === 1 || !state.lastSpeakerId) return initialPrompt;
    return [
      `[Round ${state.round}] The task remains:`,
      initialPrompt,
      "",
      `Previous speaker ${state.lastSpeakerId} said:`,
      truncate(state.lastSpeechText ?? "", 4000),
      "",
      `Continue the discussion. Use the consensus marker "${this.group.consensusMarker}" only when the group has clearly converged.`,
    ].join("\n");
  }

  private async runOneTurn(
    agentId: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const agent = this.group.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`unknown agent id "${agentId}" in group "${this.group.id}"`);

    const provider = await this.providerResolver(agent.providerId);
    const runtime = this.runtimeFactory({
      agent,
      provider,
      layout: this.layout,
      approvalHandler: this.approvalHandler,
      extraSystemPromptLayers: this.group.metaText ? [this.group.metaText] : [],
    });

    const res = await runtime.run({ prompt, signal });
    return res.text || "";
  }

  private containsConsensus(text: string): boolean {
    if (!this.group.consensusMarker) return false;
    return text.includes(this.group.consensusMarker);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

function extractAgentId(reply: string, valid: string[]): string | undefined {
  const trimmed = reply.trim();
  // Direct hit.
  if (valid.includes(trimmed)) return trimmed;
  // First whitespace-delimited token.
  const first = trimmed.split(/\s+/)[0];
  if (first && valid.includes(first)) return first;
  // First @-mention.
  const m = /@([A-Za-z0-9._-]+)/.exec(trimmed);
  if (m && valid.includes(m[1]!)) return m[1]!;
  // Substring scan as last resort.
  for (const id of valid) {
    if (trimmed.includes(id)) return id;
  }
  return undefined;
}
