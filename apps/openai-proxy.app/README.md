# openai-proxy.app

HTTP proxy that exposes a local [llama.cpp](https://github.com/ggml-org/llama.cpp)
+ Gemma model over the OpenAI v1 wire format. Built on
[`@statewalker/openai-compat`](https://github.com/statewalker/statewalker-workbench/tree/main/packages/ai-openai-compat.core) (the adapter) and
[Hono](https://hono.dev/) (the transport).

## Architecture

```
openai client (curl, openai SDK, IDE plugin, ...)
  │
  ▼  POST http://127.0.0.1:8787/v1/chat/completions
Hono server (@hono/node-server)
  │
  ▼  app.fetch(Request)
@statewalker/openai-compat handler
  │
  ▼  generateText / streamText
@ai-sdk/openai provider (baseURL = http://127.0.0.1:8080/v1)
  │
  ▼  POST http://127.0.0.1:8080/v1/chat/completions
llama-server (llama.cpp)
  │
  ▼
Gemma 3 1B GGUF
```

## Prerequisites

- `llama-server` binary from llama.cpp. Build from source or install a
  prebuilt release.
- A GGUF Gemma model. We test against
  [`ggml-org/gemma-3-1b-it-GGUF`](https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF)
  (≈1 GB at Q4_K_M). Download any quantization that fits the host's RAM.

## Start llama-server

```sh
llama-server \
  -m /path/to/gemma-3-1b-it-q4_K_M.gguf \
  --port 8080 \
  --host 127.0.0.1
```

## Start the proxy

```sh
pnpm --filter @repo/openai-proxy-app dev
# or one-shot
pnpm --filter @repo/openai-proxy-app start
```

Defaults:
- Proxy listens on `http://127.0.0.1:8787/v1`.
- llama.cpp expected at `http://127.0.0.1:8080/v1`.
- Exposed model id: `gemma-3-1b`.

Overrides:

| Env var               | Default                       | Purpose                              |
| --------------------- | ----------------------------- | ------------------------------------ |
| `OPENAI_PROXY_PORT`   | `8787`                        | Port the proxy binds to              |
| `LLAMACPP_BASE_URL`   | `http://127.0.0.1:8080/v1`    | OpenAI-compatible base URL of the backend |

## Smoke test

```sh
curl http://127.0.0.1:8787/v1/models
# {"object":"list","data":[{"id":"gemma-3-1b",...}]}

curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "gemma-3-1b",
    "messages": [{"role":"user","content":"Say hello"}]
  }'
```

Or with the official openai SDK:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "not-needed",
});

const reply = await client.chat.completions.create({
  model: "gemma-3-1b",
  messages: [{ role: "user", content: "Say hello" }],
});

console.log(reply.choices[0].message.content);
```

## Integration tests

The integration tests boot a real `llama-server` and drive the proxy
end-to-end. They are skipped by default. To run:

```sh
OPENAI_COMPAT_E2E=1 \
LLAMACPP_BIN=/path/to/llama-server \
LLAMACPP_MODEL=/path/to/gemma-3-1b-it-q4_K_M.gguf \
pnpm --filter @repo/openai-proxy-app test
```
