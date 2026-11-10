// The deployment's model config and the credentials of one run (caller token policies).
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmConfig, llmCredentials } from "../../src/llm-config.ts";

const base = { baseUrl: "https://llm.example/v1", model: "m" };

test("config: policy and header name are checked", () => {
  assert.equal(llmConfig({}), undefined);
  assert.deepEqual(llmConfig({ LLM: JSON.stringify(base) }), base);
  assert.throws(() => llmConfig({ LLM: { ...base, callerToken: "maybe" } }), /EINVAL/);
  assert.throws(() => llmConfig({ LLM: { ...base, callerTokenHeader: "x y" } }), /EINVAL/);
});

test("allow (default): the caller's token replaces the deployment key", () => {
  assert.deepEqual(llmCredentials(base, "dep"), { apiKey: "dep", headers: {} });
  assert.deepEqual(llmCredentials(base, "dep", "tok"), { apiKey: "tok", headers: {} });
});

test("with callerTokenHeader the token goes beside the deployment key", () => {
  const c = { ...base, callerTokenHeader: "x-user-token" };
  assert.deepEqual(llmCredentials(c, "dep", "tok"), {
    apiKey: "dep",
    headers: { "x-user-token": "tok" },
  });
});

test("require and forbid", () => {
  assert.throws(() => llmCredentials({ ...base, callerToken: "require" }, "dep"), /EACCES/);
  assert.equal(llmCredentials({ ...base, callerToken: "require" }, undefined, "t").apiKey, "t");
  assert.throws(() => llmCredentials({ ...base, callerToken: "forbid" }, "dep", "t"), /EACCES/);
  assert.equal(llmCredentials({ ...base, callerToken: "forbid" }, "dep").apiKey, "dep");
});

test("a token that could break a header is refused", () => {
  for (const t of ["", "a b", "a\r\nx-evil: 1", "é", "x".repeat(4097)])
    assert.throws(() => llmCredentials(base, "dep", t), /EINVAL/, JSON.stringify(t));
});
