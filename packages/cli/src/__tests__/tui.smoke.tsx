// TUI smoke test — mounts the Ink App with a stubbed runtime and verifies
// that the rendered frame contains the agent boxes, the blackboard panel,
// and the events log. Uses Ink's render() into a fake stdout.
//
// Run: node packages/cli/dist/__tests__/tui.smoke.js

import React from "react";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import {
  ensureSessionSkeleton,
  loadGroupConfig,
  SessionLayout,
  type AgentRuntimeLike,
  type Provider,
  type RuntimeFactory,
} from "@agents/core";
import { App } from "../tui/App.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "agents-tui-"));
console.log(`tmp root: ${tmp}`);

try {
  const cfgRoot = join(tmp, "configs");
  const agentsCfg = join(cfgRoot, "agents");
  const groupsCfg = join(cfgRoot, "groups");
  mkdirSync(agentsCfg, { recursive: true });
  mkdirSync(groupsCfg, { recursive: true });

  for (const id of ["alpha", "beta"]) {
    writeFileSync(
      join(agentsCfg, `${id}.json`),
      JSON.stringify(
        {
          id,
          name: id.toUpperCase(),
          providerId: "fake",
          systemPromptText: `You are ${id}.`,
          allowedTools: [],
          maxTurns: 1,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const groupPath = join(groupsCfg, "g.json");
  writeFileSync(
    groupPath,
    JSON.stringify(
      {
        id: "g",
        name: "Tiny Group",
        agents: ["alpha", "beta"],
        mode: "round-robin",
        maxRounds: 2,
        meta: "## Group Meta\nblackboard demo",
      },
      null,
      2,
    ),
    "utf8",
  );

  const workspaces = join(tmp, "workspaces");
  mkdirSync(workspaces, { recursive: true });

  const group = await loadGroupConfig(groupPath);
  const layout = new SessionLayout(workspaces, "tui-demo");
  await ensureSessionSkeleton(layout);

  const provider: Provider = {
    id: "fake",
    name: "Fake",
    source: "memory",
    env: { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "k" },
    models: ["claude-opus-4-7"],
  };
  const providerResolver = async () => provider;

  const factory: RuntimeFactory = ({ agent }) =>
    ({
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { text: `HELLO_FROM_${agent.id.toUpperCase()}` };
      },
    }) as AgentRuntimeLike;

  const inst = render(
    React.createElement(App, {
      group,
      layout,
      initialPrompt: "say hello",
      providerResolver,
      runtimeFactory: factory,
    }),
  );

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((inst.lastFrame() ?? "").includes("FINISHED")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  inst.unmount();

  const frame = inst.lastFrame() ?? "";
  check("frame has group name", frame.includes("Tiny Group"));
  check("frame has alpha agent box", frame.includes("ALPHA") && frame.includes("[alpha]"));
  check("frame has beta agent box", frame.includes("BETA") && frame.includes("[beta]"));
  check("frame shows blackboard label", frame.includes("blackboard"));
  check("frame shows alpha turn text", frame.includes("HELLO_FROM_ALPHA"));
  check("frame shows beta turn text", frame.includes("HELLO_FROM_BETA"));
  check("frame shows finished banner", frame.includes("FINISHED"));
  check("frame shows reason=max-rounds", frame.includes("reason=max-rounds"));

  console.log(`\n${failures === 0 ? "ALL OK" : `FAILED (${failures})`}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
