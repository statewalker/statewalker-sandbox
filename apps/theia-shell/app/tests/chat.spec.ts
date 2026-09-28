/**
 * The chat against a custom OpenAI-compatible endpoint, and the Mesh view
 * before joining: no mesh involved. The endpoint is a fake served by the test
 * (models, and a reply streamed one word per SSE event).
 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { runFromPalette, start } from "./helpers";

const KEY = "sk-custom";
let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      return void res
        .writeHead(401, { ...cors, "content-type": "application/json" })
        .end('{"error":"bad key"}');
    }
    if (req.url === "/v1/models") {
      return void res
        .writeHead(200, { ...cors, "content-type": "application/json" })
        .end(JSON.stringify({ data: [{ id: "gpt-b" }, { id: "gpt-a" }] }));
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const { model, messages } = JSON.parse(body);
    res.writeHead(200, { ...cors, "content-type": "text/event-stream" });
    for (const word of `**${model}** says: ${messages.at(-1).content}`.split(" ")) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${word} ` } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.afterAll(() => {
  server?.close();
});

test("the Mesh view offers to join before this browser has an identity in a mesh", async ({
  page,
}) => {
  const errors = await start(page, "?storage=memory");
  await page.locator("#shell-tab-httpeers-mesh").click();
  const mesh = page.locator("#httpeers-mesh");
  await expect(mesh.getByRole("button", { name: "Join" })).toBeVisible();
  await expect(mesh.getByText("Join a mesh to see its peers.")).toBeVisible();
  await expect(page.locator("#status-bar-httpeers-mesh-status")).toContainText("Mesh: not joined");
  expect(errors).toEqual([]);
});

test("chats with a custom endpoint, rendering Markdown, and keeps the chat across a reload", async ({
  page,
}) => {
  const errors = await start(page, "?storage=memory");
  await runFromPalette(page, "Toggle LLM Chat");
  const chat = page.locator(".llm-chat");
  await expect(chat.getByText("Join a mesh")).toBeVisible();

  await chat.getByLabel("Endpoint").selectOption("custom");
  const settings = chat.getByRole("form", { name: "Endpoint settings" });
  await settings.getByLabel("Base URL").fill(baseUrl);
  await settings.getByLabel("API key").fill("wrong");
  await settings.getByRole("button", { name: "Connect" }).click();
  await expect(settings.getByRole("alert")).toContainText("401");

  await settings.getByLabel("API key").fill(KEY);
  await settings.getByRole("button", { name: "Connect" }).click();
  await expect(chat.getByLabel("Model")).toHaveValue("gpt-a");
  await chat.getByLabel("Model").selectOption("gpt-b");

  await chat.getByLabel("Message").fill("hi there");
  await chat.getByLabel("Message").press("Enter");
  const reply = chat.locator(".llm-chat-message.assistant");
  await expect(reply).toContainText("gpt-b says: hi there");
  // Markdown, rendered: the model name is bold.
  await expect(reply.locator("strong")).toHaveText("gpt-b");

  await page.reload();
  await expect(page.locator("#files").getByText("welcome.md", { exact: true })).toBeVisible();
  // The layout restorer brings the chat back.
  await expect(chat.getByLabel("Endpoint")).toHaveValue("custom");
  await expect(chat.getByLabel("Model")).toHaveValue("gpt-b");
  await chat.locator(".llm-chat-list").getByText("hi there").click();
  await expect(chat.locator(".llm-chat-message.user")).toHaveText("hi there");
  expect(errors).toEqual([]);
});

test("the proxy keeps a route across a reload but not its credential", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  await runFromPalette(page, "Toggle Mesh Proxy");
  const proxy = page.locator(".httpeers-proxy");
  const form = proxy.getByRole("form", { name: "Add a route" });

  await form.getByLabel("Prefix").fill("api");
  await form.getByLabel("Upstream URL").fill(baseUrl);
  await form.getByRole("button", { name: "Add route" }).click();
  await expect(proxy.getByRole("status")).toContainText("The prefix must be a path");

  await form.getByLabel("Prefix").fill("/llm");
  await form.getByLabel("Credential header").fill("authorization");
  await form.getByLabel("Credential value").fill(`Bearer ${KEY}`);
  await form.getByRole("button", { name: "Add route" }).click();
  const routes = proxy.getByRole("table", { name: "Routes" });
  await expect(routes).toContainText("authorization ✓");

  const console_ = proxy.getByRole("form", { name: "Test console" });
  await console_.getByLabel("Path").fill("/llm/models");
  await console_.getByRole("button", { name: "Send" }).click();
  await expect(proxy.locator(".httpeers-proxy-output")).toContainText("gpt-a");

  await page.reload();
  await expect(page.locator("#files").getByText("welcome.md", { exact: true })).toBeVisible();
  // The layout restorer brings the proxy view back.
  await expect(routes).toContainText("authorization (re-enter after reload)");
  await console_.getByLabel("Path").fill("/llm/models");
  await console_.getByRole("button", { name: "Send" }).click();
  await expect(proxy.locator(".httpeers-proxy-output")).toContainText("401");
  expect(errors).toEqual([]);
});
