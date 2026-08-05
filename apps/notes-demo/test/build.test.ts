import { readFile, readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newProjectBuild } from "@statewalker/webrun-modules-build";

/**
 * End-to-end assertion of the no-bundle emit: build the guest sources with a
 * MemFilesApi project + cache (no network — Tailwind/CSS/assets are generated
 * locally) and assert the emitted `/~/…` tree proves Phase-3 features F1/F2/F3.
 *
 * The guest CSS is copied inline here (not read from src/) so the test is a
 * hermetic contract check against `newProjectBuild` output.
 */
async function buildGuest() {
  const project = new MemFilesApi();
  await writeText(project, "/main.tsx", `import "./styles.css";\nexport const x = 1;`);
  await writeText(project, "/styles.css", `@import "tailwindcss";\n@import "./tokens.css";`);
  await writeText(
    project,
    "/tokens.css",
    `@theme { --color-brand: #4f46e5; }\n.logo { background-image: url("./logo.svg"); }`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>`;
  await writeText(project, "/logo.svg", svg);
  const cache = new MemFilesApi();
  const { served } = await newProjectBuild({ project, cache }).build();
  return { cache, served, svg };
}

describe("notes-demo no-bundle build", () => {
  it("Tailwind: /~/styles.js injector carries generic utilities AND the custom bg-brand", async () => {
    const { cache } = await buildGuest();
    expect(await cache.exists("/~/styles.js")).toBe(true);
    const injector = await readText(cache, "/~/styles.js");
    // Generic Tailwind utilities prove the transform ran over the full class set.
    expect(injector).toContain(".flex");
    expect(injector).toContain(".p-4");
    // The @theme token (reached via the F2 @import chain) yields a real bg-brand.
    expect(injector).toContain("bg-brand");
    expect(injector).toContain("#4f46e5");
  });

  it("F2: a real /~/tokens.css stylesheet is emitted from the @import chain", async () => {
    const { cache } = await buildGuest();
    expect(await cache.exists("/~/tokens.css")).toBe(true);
    const tokens = await readText(cache, "/~/tokens.css");
    expect(tokens).toContain(".logo");
  });

  it("F3: the url()-referenced /~/logo.svg asset is emitted byte-identical", async () => {
    const { cache, svg } = await buildGuest();
    expect(await cache.exists("/~/logo.svg")).toBe(true);
    const out = await readFile(cache, "/~/logo.svg");
    expect(new TextDecoder().decode(out)).toBe(svg);
  });

  it("Entry: /~/main.js exists and imports the ext-mapped styles + is a served pointer", async () => {
    const { cache, served } = await buildGuest();
    expect(await cache.exists("/~/main.js")).toBe(true);
    const main = await readText(cache, "/~/main.js");
    // The CSS import is ext-mapped to the injector .js (no bare `.css` specifier).
    expect(main).toContain("./styles.js");
    expect(main).not.toContain(`"./styles.css"`);
    expect(served).toContain("/~/main.js");
  });
});
