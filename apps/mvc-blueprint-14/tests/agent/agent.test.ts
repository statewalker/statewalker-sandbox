import { agentActionsSlot, specGeneratorAdapter } from "@b/agent/api";
import { todoForContact } from "../../src/bundles/agent.fixtures/fixtures.js";
import { catalogSlot } from "@b/catalog/api";
import type { ContactEditorView } from "@b/contacts/api";
import type { TitleFormView } from "@b/todos/api";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  add,
  agentHeadless,
  assistant,
  controlledGenerator,
  el,
  fixedGenerator,
  jsonl,
  openAssistant,
  spyCommands,
} from "../support/agent.js";
import { errorLogs, panel, type Running, settle, start, until } from "../support/harness.js";
import { contactList } from "../support/scenarios.js";

const gen = (g: unknown) => ({ services: { [specGeneratorAdapter.key]: g } });
const warns = (r: Running, message: string) =>
  r.logs.filter((l) => l.level === "warn" && l.args[0] === message);
const selectAda = async (r: Running) => {
  await until(() => contactList(r).getContacts().length === 3);
  contactList(r).select("c1");
};

describe("J1: a generated UI as an ordinary publication", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("renders the recorded fixture: spec, seeded form, data, bound actions", async () => {
    r = await start(agentHeadless, gen(fixedGenerator(todoForContact)));
    await selectAda(r);
    const view = await openAssistant(r);
    await until(() => view.getStatus().phase === "ready");
    const spec = view.getSpec();
    expect(spec?.root).toBe("card");
    expect(Object.keys(spec?.elements ?? {}).sort()).toEqual(
      ["buttons", "card", "create", "intro", "open", "people", "title"].sort(),
    );
    expect(spec).not.toHaveProperty("state"); // the seed went to the form group
    expect(view.getValues()).toEqual({ title: "Call Ada Lovelace" });
    expect(view.getData()).toEqual({
      selectedContacts: [
        { id: "c1", name: "Ada Lovelace", email: "ada@example.org", phone: "+44 20 0001" },
      ],
    });
    expect(Object.keys(view.getActions()).sort()).toEqual(["contacts.edit.open", "todos.compose"]);
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("the default generator (agent.fixtures) replays the same recording", async () => {
    r = await start(agentHeadless, { config: { "agent:fixture-delay-ms": 0 } });
    await selectAda(r);
    const view = await openAssistant(r);
    await until(() => view.getStatus().phase === "ready");
    expect(view.getValues()).toEqual({ title: "Call Ada Lovelace" });
  });

  it("the prompt is generated from the aggregated vocabulary of independent bundles", async () => {
    const c = controlledGenerator();
    r = await start(agentHeadless, gen(c.generator));
    await openAssistant(r);
    await until(() => c.requests.length === 1);
    const { system, request } = c.requests[0] as { system: string; request: string };
    expect(request).toBe("Make a todo for each selected contact");
    for (const name of ["Card", "Stack", "Text", "Input", "Select", "Checkbox", "Button", "Table"])
      expect(system).toContain(`- ${name}:`);
    expect(system).toContain("- Badge:"); // from the independent `ui.badge` feature
    expect(system).toContain("todos.compose"); // from agent.todos
    expect(system).toContain("contacts.edit.open"); // from agent.contacts
    expect(system).toContain("DATA /data/selectedContacts");
    // json-render's default prompt teaches built-ins even with `builtInActions: []`; our rule
    // overrides that text, and the policy refuses them anyway.
    expect(system).toContain("setState, pushState, removeState and validateForm DO NOT EXIST");
    c.end();
  });

  it("partial rendering: only the streamed, valid prefix is shown; actions come when complete", async () => {
    const c = controlledGenerator();
    r = await start(agentHeadless, gen(c.generator));
    await selectAda(r);
    const view = await openAssistant(r);
    const lines = todoForContact.split("\n").map((l) => `${l}\n`);
    c.push(...lines.slice(0, 3));
    await until(() => Object.keys(view.getSpec()?.elements ?? {}).length === 2);
    expect(view.getStatus().phase).toBe("streaming");
    expect(Object.keys(view.getSpec()?.elements ?? {}).sort()).toEqual(["card", "intro"]);
    expect(view.getActions()).toEqual({});
    // half a line: nothing new
    const next = lines[3] as string;
    c.push(next.slice(0, 20));
    await settle();
    expect(Object.keys(view.getSpec()?.elements ?? {})).toHaveLength(2);
    c.push(next.slice(20), ...lines.slice(4));
    await until(() => Object.keys(view.getSpec()?.elements ?? {}).length === 7);
    expect(view.getStatus().phase).toBe("streaming");
    expect(view.getActions()).toEqual({}); // nothing can be committed from a partial spec
    c.end();
    await until(() => view.getStatus().phase === "ready");
    expect(Object.keys(view.getActions())).toHaveLength(2);
  });
});

describe("J1: specs outside the catalog or the policy are refused (negative controls)", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  const ok = [
    add("/root", "card"),
    add("/elements/card", el("Card", { title: "T" }, { children: ["x"] })),
  ];
  const seedTitle = add("/state/form", { title: "t" });
  const cases: [string, object[], RegExp][] = [
    [
      "an unknown component",
      [add("/elements/x", el("Iframe", { src: "https://evil" }))],
      /x: elements\.x\.type/,
    ],
    ["bad props", [add("/elements/x", el("Button", { label: 42 }))], /x: props\.label/],
    [
      "a built-in: setState on /anything",
      [
        add(
          "/elements/x",
          el(
            "Button",
            { label: "B" },
            {
              on: { press: { action: "setState", params: { statePath: "/anything", value: 1 } } },
            },
          ),
        ),
      ],
      /"setState" is not allow-listed/,
    ],
    [
      "a real command that is not allow-listed (todos:remove)",
      [
        add(
          "/elements/x",
          el("Button", { label: "B" }, { on: { press: { action: "todos.remove" } } }),
        ),
      ],
      /"todos.remove" is not allow-listed/,
    ],
    [
      "a watcher",
      [
        add(
          "/elements/x",
          el("Text", { text: "t" }, { watch: { "/form/title": { action: "todos.compose" } } }),
        ),
      ],
      /"watch" is not allowed/,
    ],
    [
      "a binding outside the form group",
      [
        add(
          "/elements/x",
          el("Input", { label: "L", value: { $bindState: "/data/selectedContacts/0/name" } }),
        ),
      ],
      /binds \/data/,
    ],
    [
      "a read outside /form and /data",
      [add("/elements/x", el("Text", { text: { $state: "/secrets" } }))],
      /reads \/secrets/,
    ],
    [
      "a seed of /data",
      [add("/state/data", { selectedContacts: [] })],
      /may seed only \/state\/form/,
    ],
    [
      "an action list",
      [
        add(
          "/elements/x",
          el("Button", { label: "B" }, { on: { press: [{ action: "todos.compose" }] } }),
        ),
      ],
      /one binding/,
    ],
    [
      "onSuccess (an outcome decided in the view)",
      [
        add(
          "/elements/x",
          el(
            "Button",
            { label: "B" },
            {
              on: { press: { action: "todos.compose", onSuccess: { set: { "/form/title": "" } } } },
            },
          ),
        ),
      ],
      /onSuccess is not allowed/,
    ],
    [
      "an event the component does not emit",
      [
        add(
          "/elements/x",
          el("Text", { text: "t" }, { on: { hover: { action: "todos.compose" } } }),
        ),
      ],
      /emits no "hover"/,
    ],
  ];

  it.each(cases)(
    "%s: refused mid-stream, nothing shown, stream aborted, nothing touched",
    async (_n, bad, issue) => {
      const c = controlledGenerator();
      r = await start(agentHeadless, gen(c.generator));
      await selectAda(r);
      const calls = spyCommands(r.commands);
      const view = await openAssistant(r);
      c.push(...jsonl(...ok, seedTitle));
      await until(() => view.getSpec() !== null);
      c.push(...jsonl(...bad));
      await until(() => view.getStatus().phase === "invalid");
      expect(view.getSpec()).toBeNull(); // no partial rendering once refused
      expect(view.getStatus().issues.join("\n")).toMatch(issue);
      expect(view.getActions()).toEqual({});
      expect(c.signals[0]?.aborted).toBe(true);
      expect(warns(r, "agent: spec refused")).toHaveLength(1);
      await settle();
      expect(calls.filter((x) => !x.key.startsWith("sys:"))).toEqual([]);
      expect(panel(r.slots, "todos:editor")).toBeUndefined();
      expect(errorLogs(r.logs)).toEqual([]);
    },
  );

  it("complete-spec checks: an action bound twice, an unseeded binding, a dangling child", async () => {
    for (const [patches, issue] of [
      [
        [
          add("/root", "s"),
          add("/elements/s", el("Stack", {}, { children: ["a", "b"] })),
          add(
            "/elements/a",
            el(
              "Button",
              { label: "A" },
              { on: { press: { action: "todos.compose", params: { title: "a" } } } },
            ),
          ),
          add(
            "/elements/b",
            el(
              "Button",
              { label: "B" },
              { on: { press: { action: "todos.compose", params: { title: "b" } } } },
            ),
          ),
        ],
        /already bound/,
      ],
      [
        [
          add("/root", "i"),
          add("/elements/i", el("Input", { label: "L", value: { $bindState: "/form/nope" } })),
        ],
        /never seeded/,
      ],
      [
        [add("/root", "s"), add("/elements/s", el("Stack", {}, { children: ["ghost"] }))],
        /structure/,
      ],
    ] as [object[], RegExp][]) {
      const run = await start(agentHeadless, gen(fixedGenerator(jsonl(...patches))));
      const view = await openAssistant(run);
      await until(() => view.getStatus().phase !== "streaming");
      expect(view.getStatus().phase).toBe("invalid");
      expect(view.getStatus().issues.join("\n")).toMatch(issue);
      expect(view.getSpec()).toBeNull();
      await run.stop();
    }
  });

  it("the store facade refuses every write outside /form/<seeded field> and logs it", async () => {
    r = await start(agentHeadless, gen(fixedGenerator(todoForContact)));
    await selectAda(r);
    const view = await openAssistant(r);
    await until(() => view.getStatus().phase === "ready");
    const data = view.getData();
    const before = view.store.getSnapshot();
    view.store.set("/anything", 1);
    view.store.set("/data/selectedContacts", []);
    view.store.set("/form/unseeded", "x");
    view.store.set("/form/title/nested", "x");
    view.store.update({ "/data/x": 1, "/actions/todos.compose": null });
    view.editField("other", 1);
    expect(view.store.getSnapshot()).toBe(before); // not even a new identity
    expect(view.getData()).toBe(data);
    expect(warns(r, "agent: refused a write outside the form group").map((l) => l.args[1])).toEqual(
      [
        { path: "/anything" },
        { path: "/data/selectedContacts" },
        { path: "/form/unseeded" },
        { path: "/form/title/nested" },
        { path: "/data/x" },
        { path: "/actions/todos.compose" },
        { path: "/form/other" },
      ],
    );
    // …and the one allowed path works.
    view.store.set("/form/title", "Ring Ada");
    expect(view.getValues()).toEqual({ title: "Ring Ada" });
    expect(view.store.get("/form/title")).toBe("Ring Ada");
  });

  it("negative control of the negative control: an allow-listed binding passes", async () => {
    const c = controlledGenerator();
    r = await start(agentHeadless, gen(c.generator));
    const view = await openAssistant(r);
    c.push(
      ...jsonl(
        ...ok,
        seedTitle,
        add(
          "/elements/x",
          el(
            "Button",
            { label: "B" },
            {
              on: {
                press: { action: "todos.compose", params: { title: { $state: "/form/title" } } },
              },
            },
          ),
        ),
      ),
    );
    c.end();
    await until(() => view.getStatus().phase !== "streaming");
    expect(view.getStatus()).toEqual({ phase: "ready", issues: [] });
  });
});

describe("J1: commit time and single writer through the generated actions", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  const ready = async () => {
    r = await start(agentHeadless, gen(fixedGenerator(todoForContact)));
    await selectAda(r);
    const calls = spyCommands(r.commands);
    const view = await openAssistant(r);
    await until(() => view.getStatus().phase === "ready");
    return { r, view, calls, compose: () => calls.filter((c) => c.key === "todos:compose") };
  };

  it("edit, press Create, edit again in the same tick: todos:compose gets the press-time title", async () => {
    const { r, view, compose } = await ready();
    view.editField("title", "A");
    view.getActions()["todos.compose"]?.submit();
    view.editField("title", "B");
    await until(() => panel(r.slots, "todos:editor") !== undefined);
    expect(compose().map((c) => c.payload)).toEqual([{ title: "A" }]);
    const editor = panel<TitleFormView>(r.slots, "todos:editor")?.model as TitleFormView;
    expect(editor.getDraft().title).toBe("A");
    expect(view.getValues()).toEqual({ title: "B" });
    await until(() => view.getOutcome() === "Done: todos.compose");
  });

  it("a double press in one tick composes once (refused by the action), and so does a press while running", async () => {
    const { r, view, compose } = await ready();
    const create = view.getActions()["todos.compose"];
    create?.submit();
    expect(create?.getState().running).toBe(true); // flips inside submit()
    create?.submit();
    await Promise.resolve();
    create?.submit();
    await until(() => create?.getState().running === false);
    await settle();
    expect(compose()).toHaveLength(1);
    expect(panel(r.slots, "todos:editor")).toBeDefined();
  });

  it("the captured snapshot is frozen and resolved from /data too (contacts.edit.open)", async () => {
    const { r, view, calls } = await ready();
    view.getActions()["contacts.edit.open"]?.submit();
    contactList(r).select("c2"); // same tick: the data changes after the press
    await until(() => panel(r.slots, "contacts:editor") !== undefined);
    expect(calls.filter((c) => c.key === "contacts:edit:open").map((c) => c.payload)).toEqual([
      { id: "c1" },
    ]);
    const editor = panel<ContactEditorView>(r.slots, "contacts:editor")?.model as ContactEditorView;
    expect(editor.getDraft().name).toBe("Ada Lovelace");
  });

  it("params the command's schema rejects never reach the command", async () => {
    const { view, compose } = await ready();
    view.editField("title", "   ");
    view.getActions()["todos.compose"]?.submit();
    await until(() => view.getOutcome()?.startsWith("Refused") === true);
    expect(compose()).toEqual([]);
  });

  it("the vocabulary is live: withdrawing a used component or action refuses a ready spec", async () => {
    for (const withdrawn of ["component", "action"] as const) {
      const run = await start(
        agentHeadless,
        gen(
          fixedGenerator(
            jsonl(
              add("/root", "p"),
              add("/elements/p", el("Probe", {}, { on: { press: { action: "test.ping" } } })),
            ),
          ),
        ),
      );
      const pings: unknown[] = [];
      const offComponent = run.slots.register(catalogSlot, "Probe", {
        props: z.object({}),
        slots: [],
        events: ["press"],
        description: "probe",
      });
      const offAction = run.slots.register(agentActionsSlot, "test.ping", {
        description: "ping",
        params: z.object({}),
        run: async (p: unknown) => void pings.push(p),
      } as never);
      const view = await openAssistant(run);
      await until(() => view.getStatus().phase !== "streaming");
      expect(view.getStatus().phase).toBe("ready");
      (withdrawn === "component" ? offComponent : offAction)();
      expect(view.getStatus().phase).toBe("invalid");
      expect(view.getSpec()).toBeNull();
      expect(view.getStatus().issues.join("\n")).toMatch(
        withdrawn === "component" ? /type/ : /not allow-listed/,
      );
      await run.stop();
    }
  });
});

describe("J1: a session's scope", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("closing mid-stream aborts it; 0 writes after the close, even from a generator that keeps going", async () => {
    const c = controlledGenerator();
    r = await start(agentHeadless, gen(c.generator));
    const view = await openAssistant(r);
    const lines = todoForContact.split("\n").map((l) => `${l}\n`);
    c.push(...lines.slice(0, 2));
    await until(() => view.getSpec() !== null);
    const spec = view.getSpec();
    let notified = 0;
    for (const on of [
      view.onSpecUpdate,
      view.onStatusUpdate,
      view.onValuesUpdate,
      view.onActionsUpdate,
    ])
      on(() => notified++);
    notified = 0;
    view.close.submit();
    await until(() => assistant(r as Running) === undefined);
    expect(c.signals[0]?.aborted).toBe(true);
    c.push(...lines.slice(2));
    c.end();
    await settle(10);
    expect(notified).toBe(0);
    expect(view.getSpec()).toBe(spec);
    expect(view.getStatus().phase).toBe("streaming");
    expect(view.getActions()).toEqual({});
    expect(errorLogs(r.logs)).toEqual([]);
    expect(r.logs.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("a new request replaces the session (the old one is closed first)", async () => {
    const c = controlledGenerator();
    r = await start(agentHeadless, gen(c.generator));
    const first = await openAssistant(r);
    const again = await openAssistant(r);
    await until(() => assistant(r as Running) !== first);
    expect(assistant(r)).not.toBe(first);
    expect(c.signals[0]?.aborted).toBe(true);
    expect(c.signals[1]?.aborted).toBe(false);
    expect(again).toBeDefined();
  });

  it("stopping the application mid-stream: 0 errors, every slot empty, no command listener", async () => {
    const c = controlledGenerator();
    r = await start(agentHeadless, gen(c.generator));
    await selectAda(r);
    const view = await openAssistant(r);
    c.push(
      ...todoForContact
        .split("\n")
        .slice(0, 3)
        .map((l) => `${l}\n`),
    );
    await until(() => view.getSpec() !== null);
    const running = r;
    r = undefined;
    await running.stop();
    expect(c.signals[0]?.aborted).toBe(true);
    c.push("{}\n");
    c.end();
    await settle();
    const leftovers = running.slots.usage().filter((u) => u.contributions > 0 || u.observers > 0);
    expect(leftovers).toEqual([]);
    expect(running.commands.listened()).toEqual([]);
    expect(errorLogs(running.logs)).toEqual([]);
  });

  it("a generator that fails shows `error`, logs a warning, and keeps the app running", async () => {
    r = await start(
      agentHeadless,
      gen({
        // biome-ignore lint/correctness/useYield: fails before its first chunk
        async *generate() {
          throw new Error("rate limited");
        },
      }),
    );
    const view = await openAssistant(r);
    await until(() => view.getStatus().phase === "error");
    expect(view.getStatus().issues).toEqual(["Error: rate limited"]);
    expect(errorLogs(r.logs)).toEqual([]);
  });
});
