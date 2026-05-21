import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import {
  ensureSessionSkeleton,
  loadGroupConfig,
  SessionLayout,
  type LoadedGroupConfig,
  type ProviderResolver,
  type RuntimeFactory,
} from "@agents/core";
import { resolve } from "node:path";

export interface MountOptions {
  groupPath: string;
  initialPrompt: string;
  sessionId: string;
  workspacesRoot: string;
  providerResolver: ProviderResolver;
  maxRoundsOverride?: number;
  runtimeFactory?: RuntimeFactory;
}

export async function mountTui(opts: MountOptions): Promise<void> {
  const group: LoadedGroupConfig = await loadGroupConfig(opts.groupPath);
  const layout = new SessionLayout(opts.workspacesRoot, opts.sessionId);
  await ensureSessionSkeleton(layout);

  const { waitUntilExit } = render(
    React.createElement(App, {
      group,
      layout,
      initialPrompt: opts.initialPrompt,
      providerResolver: opts.providerResolver,
      maxRoundsOverride: opts.maxRoundsOverride,
      runtimeFactory: opts.runtimeFactory,
    }),
  );
  await waitUntilExit();
}

// Re-export for convenience.
export { resolve };
