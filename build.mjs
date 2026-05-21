#!/usr/bin/env node
// Build helper that works in cmd, PowerShell, and Git Bash without relying on PATH.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tsc = resolve(here, "node_modules/typescript/bin/tsc");
const args = ["-b", ...process.argv.slice(2)];
const r = spawnSync(process.execPath, [tsc, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
