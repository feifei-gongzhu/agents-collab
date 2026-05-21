// Smoke test for the blackboard module: layout classification,
// permission decisions across actors and roles, and real fs round-trip.
//
// Run: node packages/core/dist/__tests__/blackboard.smoke.js

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Blackboard,
  ensureSessionSkeleton,
  SessionLayout,
  decideWrite,
  ORCHESTRATOR_ACTOR,
  USER_ACTOR,
} from "../blackboard/index.js";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function expectKind(
  layout: SessionLayout,
  actor: string,
  target: string,
  kind: "allow" | "deny" | "approval",
  label: string,
) {
  const d = decideWrite(layout, { actor, targetPath: target });
  check(label, d.kind === kind, `got ${d.kind} (${d.reason})`);
}

const tmp = mkdtempSync(join(tmpdir(), "agents-bb-"));
const sessionId = "test-session";
const layout = new SessionLayout(tmp, sessionId);

console.log(`tmp workspaces root: ${tmp}`);

try {
  await ensureSessionSkeleton(layout);

  console.log("\n[layout.classify]");
  check(
    "blackboard/agent-recon.md is agent-area",
    layout.classify(layout.agentAreaFile("recon")).role === "agent-area",
  );
  check(
    "blackboard/agent-recon.md owner is recon",
    layout.classify(layout.agentAreaFile("recon")).ownerAgentId === "recon",
  );
  check(
    "agents/recon/notes.md is private",
    layout.classify(join(layout.agentPrivateDir("recon"), "notes.md")).role === "private",
  );
  check(
    "_meta.md role is meta",
    layout.classify(layout.metaFile).role === "meta",
  );
  check(
    "_shared.md role is shared",
    layout.classify(layout.sharedFile).role === "shared",
  );
  check(
    "session.json role is session-meta",
    layout.classify(layout.sessionMetaFile).role === "session-meta",
  );
  check(
    "outside path classified outside",
    layout.classify(join(tmp, "..", "elsewhere", "x.md")).role === "outside",
  );

  console.log("\n[permissions: agent recon]");
  expectKind(layout, "recon", layout.agentAreaFile("recon"), "allow", "writes own area");
  expectKind(
    layout,
    "recon",
    join(layout.agentPrivateDir("recon"), "scan.json"),
    "allow",
    "writes own private dir",
  );
  expectKind(
    layout,
    "recon",
    layout.agentAreaFile("vuln"),
    "approval",
    "writes other agent area -> approval",
  );
  expectKind(
    layout,
    "recon",
    join(layout.agentPrivateDir("vuln"), "x.md"),
    "approval",
    "writes other agent private -> approval",
  );
  expectKind(layout, "recon", layout.metaFile, "deny", "_meta.md denied for agents");
  expectKind(layout, "recon", layout.sharedFile, "approval", "_shared.md needs approval");
  expectKind(layout, "recon", layout.sessionMetaFile, "deny", "session.json denied");
  expectKind(
    layout,
    "recon",
    layout.turnLogFile(1, "recon"),
    "deny",
    "turn log denied even for owner agent",
  );
  expectKind(
    layout,
    "recon",
    join(tmp, "outside.md"),
    "deny",
    "path outside session denied",
  );

  console.log("\n[permissions: orchestrator]");
  expectKind(layout, ORCHESTRATOR_ACTOR, layout.turnLogFile(1, "recon"), "allow", "turn log");
  expectKind(layout, ORCHESTRATOR_ACTOR, layout.sessionMetaFile, "allow", "session.json");
  expectKind(layout, ORCHESTRATOR_ACTOR, layout.sharedFile, "allow", "_shared.md");
  expectKind(layout, ORCHESTRATOR_ACTOR, layout.metaFile, "approval", "_meta.md needs approval");
  expectKind(
    layout,
    ORCHESTRATOR_ACTOR,
    layout.agentAreaFile("recon"),
    "approval",
    "agent area needs approval",
  );

  console.log("\n[permissions: user]");
  expectKind(layout, USER_ACTOR, layout.metaFile, "allow", "user writes _meta.md");
  expectKind(layout, USER_ACTOR, layout.agentAreaFile("recon"), "allow", "user writes agent area");
  expectKind(
    layout,
    USER_ACTOR,
    join(tmp, "outside.md"),
    "deny",
    "user can't write outside session",
  );

  console.log("\n[blackboard fs round-trip]");
  const bb = new Blackboard(layout);
  await bb.appendToOwnArea("recon", "first finding: open port 80");
  await bb.appendToOwnArea("recon", "second finding: open port 443", {
    header: "## Round 2",
  });
  const ownArea = await bb.readAgentArea("recon");
  check("own area contains both findings", ownArea.includes("port 80") && ownArea.includes("port 443"));
  check("agent areas list includes recon", (await bb.listAgentAreas()).includes("recon"));

  await bb.appendTurn(1, "recon", "scanned the perimeter");
  const turns = await bb.listTurnFiles();
  check("turn list contains 0001-recon.md", turns.includes("0001-recon.md"));

  await bb.writeMeta("# Group background\n");
  check("readMeta returns content", (await bb.readMeta()).startsWith("# Group background"));

  await bb.appendShared("user broadcast: focus on auth bypass");
  check("shared file contains broadcast", (await bb.readShared()).includes("auth bypass"));

  console.log(`\n${failures === 0 ? "ALL OK" : `FAILED (${failures})`}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
