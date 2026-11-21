#!/usr/bin/env node
// Single entry point for every hook event. hooks.json only names the event;
// which policies run is decided by the registry in lib/harness.mjs.
import { runHook } from "../lib/harness.mjs";

const event = process.argv[2];
const input = JSON.parse(await readStdin());
const result = await runHook(event, input);
process.stdout.write(JSON.stringify(result.output ?? {}));
process.exit(result.exitCode);

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data || "{}";
}
