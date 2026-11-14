// The deployment's model config and the credentials of one run (caller token policies).
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmConfig, llmCredentials, redactor } from "../../src/llm-config.ts";

const base = { baseUrl: "https://llm.example/v1", model: "m" };

test("config: policy and header name are checked", () => {
  assert.equal(llmConfig({}), undefined);
  assert.deepEqual(llmConfig({ LLM: JSON.stringify(base) }), base);
  assert.throws(() => llmConfig({ LLM: { ...base, callerToken: "maybe" } }), /EINVAL/);
  assert.throws(() => llmConfig({ LLM: { ...base, callerTokenHeader: "x y" } }), /EINVAL/);
  // Never in place of the deployment's credentials or headers.
  for (const h of ["Authorization", "x-api-key", "api-key", "anthropic-version", "content-type"])
    assert.throws(() => llmConfig({ LLM: { ...base, callerTokenHeader: h } }), /EINVAL/, h);
  assert.throws(
    () => llmConfig({ LLM: { ...base, headers: { "X-Gw": "s" }, callerTokenHeader: "x-gw" } }),
    /EINVAL/,
  );
});

test("allow (default): the caller's token replaces the deployment key", () => {
  assert.deepEqual(llmCredentials(base, "dep"), { apiKey: "dep", headers: {} });
  assert.deepEqual(llmCredentials(base, "dep", "tok-1234"), { apiKey: "tok-1234", headers: {} });
});

test("with callerTokenHeader the token goes beside the deployment key", () => {
  const c = { ...base, callerTokenHeader: "x-user-token" };
  assert.deepEqual(llmCredentials(c, "dep", "tok-1234"), {
    apiKey: "dep",
    headers: { "x-user-token": "tok-1234" },
  });
});

test("require and forbid", () => {
  assert.throws(() => llmCredentials({ ...base, callerToken: "require" }, "dep"), /EACCES/);
  const t = "tok-1234";
  assert.equal(llmCredentials({ ...base, callerToken: "require" }, undefined, t).apiKey, t);
  assert.throws(() => llmCredentials({ ...base, callerToken: "forbid" }, "dep", t), /EACCES/);
  assert.equal(llmCredentials({ ...base, callerToken: "forbid" }, "dep").apiKey, "dep");
});

test("a token that could break a header is refused", () => {
  for (const t of [
    "",
    "short",
    "abcd efgh",
    'tok"12345',
    "a\r\nx-evil: 1",
    "é".repeat(9),
    "x".repeat(4097),
  ])
    assert.throws(() => llmCredentials(base, "dep", t), /EINVAL/, JSON.stringify(t));
});

test("an Anthropic OAuth token is not taken as the API key", () => {
  const c = { ...base, api: "anthropic-messages" };
  assert.throws(() => llmCredentials(c, "dep", "sk-ant-oat01-abcdef"), /EINVAL/);
  assert.equal(llmCredentials(c, "dep", "sk-ant-api03-abcdef").apiKey, "sk-ant-api03-abcdef");
});

test("redaction covers the raw and the JSON-escaped forms", () => {
  const r = redactor(["sk-dep-123", 'a"b\\c-123', undefined, "ab"]);
  assert.equal(r("key sk-dep-123!"), "key <redacted>!");
  assert.equal(r(JSON.stringify({ m: 'a"b\\c-123' })), '{"m":"<redacted>"}');
  assert.equal(r("ab stays"), "ab stays", "too short to redact safely");
});
