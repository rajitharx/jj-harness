#!/usr/bin/env node
// Single entry point for every hook event. hooks.json only names the event;
// which policies run is decided by the registry in hooks/policies/index.mjs.
import { runHook } from "../lib/harness.mjs";

const event = process.argv[2];
let input = {};
try {
  input = JSON.parse((await readStdin()) || "{}");
} catch (err) {
  process.stderr.write(`[harness] could not parse hook input: ${err.message}\n`);
}

try {
  const result = await runHook(event, input);
  process.stdout.write(JSON.stringify(result.output));
  // Set exitCode rather than calling process.exit(): exiting immediately can
  // cut off stdout writes larger than the pipe buffer (64 KB on macOS).
  process.exitCode = result.exitCode;
} catch (err) {
  // Last-resort fail open.
  process.stderr.write(`[harness] ${err?.stack ?? err}\n`);
  process.exitCode = 0;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
