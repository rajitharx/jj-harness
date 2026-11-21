import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICIES } from "../hooks/policies/index.mjs";

test("hooks.json declares exactly the events in the policy registry", () => {
  const hooks = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url))).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), Object.keys(POLICIES).sort());
});
