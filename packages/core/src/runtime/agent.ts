/**
 * AgentRuntime — wraps Claude Agent SDK's `query()` so that:
 *
 *   - The agent process inherits the chosen Provider's env (ANTHROPIC_BASE_URL, AUTH_TOKEN, MODEL...)
 *   - cwd is locked to the agent's private dir (workspaces/<sid>/agents/<id>/)
 *   - additionalDirectories grants read access to the whole session root
 *   - canUseTool calls decideWrite() for any path-touching tool, escalating to
 *     the user-supplied ApprovalHandler when needed
 *   - Caller receives a typed event stream (text deltas, tool uses, results)
 *
 * The runtime does NOT manage turn order or moderator logic — that lives in
 * Task #1 (orchestrator). One AgentRuntime instance handles one agent's
 * single turn at a time.
 */

import { resolve } from "node:path";
import { query, type Options as SDKOptions, type CanUseTool, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ensureAgentArea, SessionLayout, decideWrite } from "../blackboard/index.js";
import type { Provider } from "../providers/index.js";
import type { LoadedAgentConfig } from "./config.js";
import type { ApprovalHandler, ApprovalRequest } from "./approval.js";
import { denyAllApprovalHandler } from "./approval.js";

/** Tool names whose input touches a file path we should permission-check. */
const PATH_TOOLS: Record<string, (input: Record<string, unknown>) => string[]> = {
  Edit: (i) => stringList(i.file_path),
  Write: (i) => stringList(i.file_path),
  MultiEdit: (i) => stringList(i.file_path),
  NotebookEdit: (i) => stringList(i.notebook_path),
};

function stringList(v: unknown): string[] {
  return typeof v === "string" ? [v] : [];
}

export interface AgentRuntimeOptions {
  agent: LoadedAgentConfig;
  provider: Provider;
  layout: SessionLayout;
  approvalHandler?: ApprovalHandler;
  /** Extra system prompt fragments stacked after the agent's own systemPromptText. */
  extraSystemPromptLayers?: string[];
}

export interface AgentRunOptions {
  /** The user / moderator turn this agent is responding to. */
  prompt: string;
  /** External abort. */
  signal?: AbortSignal;
  /** Streaming callback for any SDK message we receive. */
  onMessage?: (msg: SDKMessage) => void;
}

export interface AgentRunResult {
  /** Final text answer assembled from assistant messages (best-effort). */
  text: string;
  /** Number of conversation turns the SDK reported. */
  numTurns: number;
  /** Anthropic API cost reported by the SDK, if any. */
  totalCostUsd?: number;
  /** True when the SDK reported subtype === 'success'. */
  success: boolean;
  /** Underlying messages, in order. */
  messages: SDKMessage[];
}

export class AgentRuntime {
  readonly agent: LoadedAgentConfig;
  readonly provider: Provider;
  readonly layout: SessionLayout;
  private readonly approvalHandler: ApprovalHandler;
  private readonly extraSystemPromptLayers: string[];

  constructor(opts: AgentRuntimeOptions) {
    this.agent = opts.agent;
    this.provider = opts.provider;
    this.layout = opts.layout;
    this.approvalHandler = opts.approvalHandler ?? denyAllApprovalHandler;
    this.extraSystemPromptLayers = opts.extraSystemPromptLayers ?? [];
  }

  /** Compose the agent's effective system prompt (group meta + role + rules). */
  buildSystemPrompt(): string {
    const layers: string[] = [];
    if (this.agent.systemPromptText) layers.push(this.agent.systemPromptText.trim());
    for (const extra of this.extraSystemPromptLayers) {
      const t = extra?.trim();
      if (t) layers.push(t);
    }
    return layers.join("\n\n---\n\n");
  }

  buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const [k, v] of Object.entries(this.provider.env)) {
      env[k] = v;
    }
    if (this.agent.model) env.ANTHROPIC_MODEL = this.agent.model;
    return env;
  }

  /** Build the SDK Options object. Exposed for testing / inspection. */
  async buildOptions(extraSignal?: AbortSignal): Promise<SDKOptions> {
    const { privateDir } = await ensureAgentArea(this.layout, this.agent.id);

    const opts: SDKOptions = {
      cwd: privateDir,
      env: this.buildEnv(),
      additionalDirectories: [resolve(this.layout.root)],
      systemPrompt: this.buildSystemPrompt() || undefined,
      allowedTools: this.agent.allowedTools,
      disallowedTools: this.agent.disallowedTools,
      maxTurns: this.agent.maxTurns ?? 8,
      model: this.agent.model,
      canUseTool: this.makeCanUseTool(),
      // Don't let SDK auto-load filesystem CLAUDE.md / settings — we layer them ourselves.
      settingSources: [],
    };

    if (extraSignal) {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      extraSignal.addEventListener("abort", onAbort, { once: true });
      opts.abortController = ac;
    }

    return opts;
  }

  private makeCanUseTool(): CanUseTool {
    return async (toolName, input): Promise<PermissionResult> => {
      const pathExtractor = PATH_TOOLS[toolName];
      if (!pathExtractor) {
        // Non-filesystem-write tool: defer to SDK defaults.
        return { behavior: "allow", updatedInput: input };
      }

      const targets = pathExtractor(input);
      if (targets.length === 0) {
        return { behavior: "allow", updatedInput: input };
      }

      for (const target of targets) {
        const abs = resolve(this.layout.agentPrivateDir(this.agent.id), target);
        const decision = decideWrite(this.layout, {
          actor: this.agent.id,
          targetPath: abs,
        });

        if (decision.kind === "deny") {
          return {
            behavior: "deny",
            message: `[blackboard] write refused for ${target}: ${decision.reason}`,
          };
        }

        if (decision.kind === "approval") {
          const cls = this.layout.classify(abs);
          const req: ApprovalRequest = {
            actor: this.agent.id,
            toolName,
            toolInput: input,
            targetPath: abs,
            classification: cls,
            reason: decision.reason,
          };
          const resp = await this.approvalHandler(req);
          if (resp.decision === "deny") {
            return {
              behavior: "deny",
              message: resp.message,
              interrupt: resp.interrupt,
            };
          }
          // Allow with optional input rewrite.
          return {
            behavior: "allow",
            updatedInput: resp.updatedInput ?? input,
          };
        }
      }

      // All targets allowed.
      return { behavior: "allow", updatedInput: input };
    };
  }

  /** Single-turn run. The SDK iterates internally up to maxTurns. */
  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const sdkOptions = await this.buildOptions(opts.signal);
    const messages: SDKMessage[] = [];

    const q = query({ prompt: opts.prompt, options: sdkOptions });
    let textBuf = "";
    let success = false;
    let numTurns = 0;
    let totalCostUsd: number | undefined;

    for await (const msg of q) {
      messages.push(msg);
      opts.onMessage?.(msg);

      if (msg.type === "assistant") {
        for (const block of msg.message.content ?? []) {
          if ((block as { type?: string }).type === "text") {
            const t = (block as { text?: string }).text ?? "";
            if (t) textBuf += (textBuf ? "\n" : "") + t;
          }
        }
      } else if (msg.type === "result") {
        numTurns = msg.num_turns;
        totalCostUsd = msg.total_cost_usd;
        if (msg.subtype === "success") {
          success = true;
          if (msg.result) textBuf = msg.result;
        }
      }
    }

    return { text: textBuf, numTurns, totalCostUsd, success, messages };
  }
}
