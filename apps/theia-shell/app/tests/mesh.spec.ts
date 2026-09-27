/**
 * The mesh, end to end, against a real one on loopback (`tools/mesh-stack.mjs`):
 * a circuit relay, the Node hub daemon with its `llm` service, a fake LiteLLM
 * and an outside HTTP origin. Nothing is stubbed on the app's side: members
 * join from invitation links, reach the hub over libp2p, and call each other
 * through the ServiceWorker edge.
 *
 * Needs the httpeers checkout built (see `tools/mesh-stack.mjs`).
 */
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { runFromPalette } from "./helpers";
import { type MeshStack, startMeshStack } from "./mesh-stack";

const APP = "http://127.0.0.1:3100/";

let stack: MeshStack;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stack = await startMeshStack(APP);
});

test.afterAll(async () => {
  await admin?.context.close();
  await stack?.stop();
});

const status = (page: Page) => page.locator("#status-bar-httpeers-mesh-status");
const meshView = (page: Page) => page.locator("#httpeers-mesh");

/** A fresh browser profile (its own identity, ServiceWorker and storage) joining from `link`. */
async function member(
  browser: Browser,
  link: string,
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  await page.goto(`${link}&storage=memory`);
  await expect(status(page)).toContainText("Mesh: live", { timeout: 60_000 });
  return { context, page, errors };
}

async function showMesh(page: Page) {
  if (!(await meshView(page).isVisible())) await page.locator("#shell-tab-httpeers-mesh").click();
  await expect(meshView(page)).toBeVisible();
}

let admin: Awaited<ReturnType<typeof member>>;

test("an admin joins from an invitation link and sees the hub and its LLM service", async ({
  browser,
}) => {
  admin = await member(browser, await stack.invitation("admin"));
  const { page } = admin;

  // The spent invitation is dropped from the address bar, so a reload resumes instead.
  expect(new URL(page.url()).searchParams.has("join")).toBe(false);

  await showMesh(page);
  await expect(meshView(page).getByText("Connected (direct)")).toBeVisible();
  const hub = meshView(page).locator(`.httpeers-peer[data-peer="${stack.hubPeerId}"]`);
  await expect(hub.locator(".httpeers-badge.hub")).toBeVisible();
  await expect(hub.locator(".httpeers-service", { hasText: "LLM" })).toBeVisible();
  const self = meshView(page).locator(".httpeers-peer").first();
  await expect(self.locator(".httpeers-badge.self")).toBeVisible();
  await expect(self.locator(".httpeers-badge.role", { hasText: "admin" })).toBeVisible();
});

test("the admin chats with the mesh's LLM, with a key requested from the hub", async () => {
  const { page } = admin;
  await runFromPalette(page, "Toggle LLM Chat");
  const chat = page.locator(".llm-chat");
  await expect(chat.getByLabel("Endpoint")).toHaveValue("mesh");

  await chat.getByRole("button", { name: "Request a key" }).click();
  await expect(chat.getByLabel("Model")).toHaveValue("fake-alpha");
  await expect(chat.getByRole("link", { name: "LiteLLM dashboard" })).toHaveAttribute(
    "href",
    new RegExp(`/peers/${stack.hubPeerId}/llm/ui/$`),
  );

  await chat.getByLabel("Message").fill("hello mesh");
  await chat.getByLabel("Message").press("Enter");
  await expect(chat.locator(".llm-chat-message.assistant")).toContainText(
    'Reply to "hello mesh" from fake-alpha.',
  );
  await expect(chat.locator(".llm-chat-list")).toContainText("hello mesh");
  expect((await stack.llmStats()).completions).toBe(1);
});

test("the admin serves a proxy route and invites a member from the Mesh view", async ({
  browser,
}) => {
  const { page } = admin;
  await runFromPalette(page, "Toggle Mesh Proxy");
  const proxy = page.locator(".httpeers-proxy");
  const form = proxy.getByRole("form", { name: "Add a route" });
  await form.getByLabel("Prefix").fill("/out");
  await form.getByLabel("Upstream URL").fill(stack.outsideUrl);
  await form.getByRole("button", { name: "Add route" }).click();
  await expect(proxy.getByRole("table", { name: "Routes" })).toContainText("/out");

  // The console tries the route in process.
  const console_ = proxy.getByRole("form", { name: "Test console" });
  await console_.getByLabel("Path").fill("/out/hello");
  await console_.getByRole("button", { name: "Send" }).click();
  await expect(proxy.locator(".httpeers-proxy-output")).toContainText("200");
  await expect(proxy.locator(".httpeers-proxy-output")).toContainText("from the outside origin");

  // An invitation from the join widget's Invite panel, as a member.
  await showMesh(page);
  await meshView(page).getByText("Invite someone").click();
  await meshView(page).getByRole("button", { name: "Create invitation" }).click();
  const link = meshView(page).getByLabel("Invitation link");
  await expect(link).toHaveValue(/\?join=/);
  const invitation = await link.inputValue();

  // The member joins with it, in a browser profile of its own.
  const other = await member(browser, invitation);
  try {
    await showMesh(other.page);
    const adminRow = meshView(other.page).locator(
      `.httpeers-peer[data-peer="${await selfId(page)}"]`,
    );
    await expect(adminRow.locator(".httpeers-service", { hasText: "Proxy" })).toBeVisible({
      timeout: 30_000,
    });

    // ...and reaches the outside origin through the admin's proxy, over the mesh.
    await runFromPalette(other.page, "Toggle Mesh Proxy");
    const theirs = other.page.locator(".httpeers-proxy");
    const target = theirs.getByLabel("Target");
    await target.selectOption({ index: 1 });
    await theirs.getByLabel("Path").fill("/out/hello");
    await theirs.getByRole("button", { name: "Send" }).click();
    const output = theirs.locator(".httpeers-proxy-output");
    await expect(output).toContainText("200");
    await expect(output).toContainText('"path":"/hello"');
    // The membership token stayed inside the mesh.
    await expect(output).toContainText('"sawMeshToken":false');

    // A member is refused a key: only an admin may request one.
    await runFromPalette(other.page, "Toggle LLM Chat");
    const chat = other.page.locator(".llm-chat");
    await chat.getByRole("button", { name: "Request a key" }).click();
    await expect(chat.getByRole("alert")).toContainText("403");
    expect(other.errors).toEqual([]);
  } finally {
    await other.context.close();
  }
  expect(admin.errors).toEqual([]);
});

async function selfId(page: Page): Promise<string> {
  const row = meshView(page).locator(".httpeers-peer").first();
  return (await row.getAttribute("data-peer")) ?? "";
}
