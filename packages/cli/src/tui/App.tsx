// Ink-based TUI app for `agents tui`.
//
// Layout:
//   [header: session/group/mode/round]
//   [agent boxes grid]   [blackboard panel]
//   [event log]
//   [approval modal — when active, intercepts input]
//
// Keys:
//   q / Esc → exit
//   tab     → cycle blackboard view (meta → shared → agent areas)
//   y / n   → approve / deny when modal is up

import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  Blackboard,
  Orchestrator,
  SessionLayout,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  type LoadedGroupConfig,
  type OrchestratorEvent,
  type ProviderResolver,
  type RuntimeFactory,
} from "@agents/core";

interface AppProps {
  group: LoadedGroupConfig;
  layout: SessionLayout;
  initialPrompt: string;
  providerResolver: ProviderResolver;
  maxRoundsOverride?: number;
  /** Test seam — replaces the default AgentRuntime. */
  runtimeFactory?: RuntimeFactory;
}

interface AgentSnapshot {
  id: string;
  name: string;
  status: "idle" | "speaking" | "spoke";
  lastPreview: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (resp: ApprovalResponse) => void;
}

const MAX_PREVIEW = 200;
const MAX_EVENTS = 8;

export function App(props: AppProps) {
  const { exit } = useApp();
  const [agents, setAgents] = useState<AgentSnapshot[]>(() =>
    props.group.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: "idle" as const,
      lastPreview: "",
    })),
  );
  const [round, setRound] = useState<number>(1);
  const [events, setEvents] = useState<string[]>([]);
  const [bbView, setBbView] = useState<number>(0);
  const [bbContent, setBbContent] = useState<string>("");
  const [bbLabel, setBbLabel] = useState<string>("(loading)");
  const [finished, setFinished] = useState<{
    reason: string;
    consensusBy?: string;
  } | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);

  // ---- Orchestrator wire-up (runs once) ----
  useEffect(() => {
    const blackboard = new Blackboard(props.layout);

    const refreshBlackboard = async () => {
      const labels: string[] = ["meta", "shared", ...props.group.agents.map((a) => `agent:${a.id}`)];
      const idx = bbView % labels.length;
      const label = labels[idx]!;
      try {
        let body = "";
        if (label === "meta") body = await blackboard.readMeta();
        else if (label === "shared") body = await blackboard.readShared();
        else body = await blackboard.readAgentArea(label.slice("agent:".length));
        setBbLabel(label);
        setBbContent(body || "(empty)");
      } catch (err) {
        setBbContent(`(error: ${(err as Error).message})`);
      }
    };

    void refreshBlackboard();

    const approvalHandler: ApprovalHandler = (req) =>
      new Promise<ApprovalResponse>((resolve) => {
        setPending({ request: req, resolve });
      });

    const onEvent = (e: OrchestratorEvent) => {
      if (e.round !== undefined) setRound(e.round);
      const tag = e.type;
      const detail = `${e.agentId ?? ""}${e.reason ? ` (${e.reason})` : ""}`.trim();
      setEvents((prev) =>
        [...prev, `[${new Date().toLocaleTimeString()}] ${tag} ${detail}`].slice(-MAX_EVENTS),
      );

      if (e.type === "agent-speaking" && e.agentId) {
        setAgents((cur) =>
          cur.map((a) => (a.id === e.agentId ? { ...a, status: "speaking" } : a)),
        );
      } else if (e.type === "agent-spoke" && e.agentId) {
        const preview = (e.text ?? "").replace(/\s+/g, " ").slice(0, MAX_PREVIEW);
        setAgents((cur) =>
          cur.map((a) =>
            a.id === e.agentId ? { ...a, status: "spoke", lastPreview: preview } : a,
          ),
        );
        // refresh blackboard view after each turn
        void refreshBlackboard();
      }
    };

    const orch = new Orchestrator({
      group: props.group,
      layout: props.layout,
      providerResolver: props.providerResolver,
      approvalHandler,
      maxRoundsOverride: props.maxRoundsOverride,
      runtimeFactory: props.runtimeFactory,
    });

    orch
      .run({ initialPrompt: props.initialPrompt, onEvent })
      .then((res) => setFinished({ reason: res.reason, consensusBy: res.consensusAgentId }))
      .catch((err) => {
        setEvents((prev) => [...prev, `[ERROR] ${(err as Error).message}`].slice(-MAX_EVENTS));
        setFinished({ reason: "error" });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Refresh blackboard when bbView changes ----
  useEffect(() => {
    const blackboard = new Blackboard(props.layout);
    const labels: string[] = ["meta", "shared", ...props.group.agents.map((a) => `agent:${a.id}`)];
    const idx = bbView % labels.length;
    const label = labels[idx]!;
    (async () => {
      try {
        let body = "";
        if (label === "meta") body = await blackboard.readMeta();
        else if (label === "shared") body = await blackboard.readShared();
        else body = await blackboard.readAgentArea(label.slice("agent:".length));
        setBbLabel(label);
        setBbContent(body || "(empty)");
      } catch (err) {
        setBbContent(`(error: ${(err as Error).message})`);
      }
    })();
  }, [bbView, props.group.agents, props.layout]);

  // ---- Keyboard ----
  useInput((input, key) => {
    if (pending) {
      if (input === "y") {
        pending.resolve({ decision: "allow" });
        setPending(null);
      } else if (input === "n") {
        pending.resolve({ decision: "deny", message: "user declined via TUI" });
        setPending(null);
      }
      return;
    }
    if (input === "q" || key.escape) exit();
    if (key.tab) setBbView((v) => v + 1);
  });

  const max = props.maxRoundsOverride ?? props.group.maxRounds;

  return (
    <Box flexDirection="column" width={"100%"}>
      <Header
        sessionId={props.layout.sessionId}
        groupName={props.group.name}
        groupId={props.group.id}
        mode={props.group.mode}
        round={round}
        max={max}
      />
      <Box flexDirection="row">
        <Box flexDirection="column" width="60%">
          {agents.map((a) => (
            <AgentBox key={a.id} a={a} />
          ))}
        </Box>
        <BlackboardPanel label={bbLabel} content={bbContent} />
      </Box>
      <EventLog events={events} />
      {finished ? (
        <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1}>
          <Text>
            FINISHED reason={finished.reason}
            {finished.consensusBy ? ` (consensus by ${finished.consensusBy})` : ""}
            {"  — press q to quit"}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>q quit · tab cycle blackboard{pending ? " · y allow / n deny (modal)" : ""}</Text>
        </Box>
      )}
      {pending ? <ApprovalModal req={pending.request} /> : null}
    </Box>
  );
}

function Header(props: {
  sessionId: string;
  groupName: string;
  groupId: string;
  mode: string;
  round: number;
  max: number;
}) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="row" justifyContent="space-between">
      <Text>
        <Text bold>{props.groupName}</Text> [{props.groupId}] · mode={props.mode}
      </Text>
      <Text>
        round <Text color="yellow">{props.round}</Text>/{props.max}
      </Text>
      <Text dimColor>session={props.sessionId}</Text>
    </Box>
  );
}

function AgentBox({ a }: { a: AgentSnapshot }) {
  const color =
    a.status === "speaking" ? "yellow" : a.status === "spoke" ? "green" : "gray";
  const tag = a.status === "speaking" ? "● speaking" : a.status === "spoke" ? "✓ spoke" : "○ idle";
  return (
    <Box borderStyle="single" borderColor={color} paddingX={1} flexDirection="column">
      <Text>
        <Text bold>{a.name}</Text> <Text dimColor>[{a.id}]</Text>{"  "}
        <Text color={color}>{tag}</Text>
      </Text>
      <Text wrap="wrap">{a.lastPreview || "(no speech yet)"}</Text>
    </Box>
  );
}

function BlackboardPanel({ label, content }: { label: string; content: string }) {
  const trimmed =
    content.length > 1500 ? content.slice(0, 1500) + "\n…[truncated]" : content;
  return (
    <Box
      borderStyle="single"
      borderColor="magenta"
      width="40%"
      flexDirection="column"
      paddingX={1}
    >
      <Text>
        <Text bold>blackboard</Text> · <Text color="magenta">{label}</Text> <Text dimColor>(tab to switch)</Text>
      </Text>
      <Text wrap="wrap">{trimmed || "(empty)"}</Text>
    </Box>
  );
}

function EventLog({ events }: { events: string[] }) {
  return (
    <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
      <Text>
        <Text bold>events</Text>
      </Text>
      {events.length === 0 ? <Text dimColor>(no events yet)</Text> : null}
      {events.map((e, i) => (
        <Text key={i}>{e}</Text>
      ))}
    </Box>
  );
}

function ApprovalModal({ req }: { req: ApprovalRequest }) {
  return (
    <Box
      borderStyle="double"
      borderColor="redBright"
      paddingX={1}
      marginTop={1}
      flexDirection="column"
    >
      <Text bold color="redBright">
        APPROVAL REQUIRED
      </Text>
      <Text>
        actor: <Text color="yellow">{req.actor}</Text> · tool: <Text color="cyan">{req.toolName}</Text>
      </Text>
      <Text>target: {req.targetPath}</Text>
      <Text>
        role: {req.classification.role}
        {req.classification.ownerAgentId ? ` (owner=${req.classification.ownerAgentId})` : ""}
      </Text>
      <Text dimColor>{req.reason}</Text>
      <Text>
        [<Text color="green">y</Text>] allow · [<Text color="red">n</Text>] deny
      </Text>
    </Box>
  );
}
