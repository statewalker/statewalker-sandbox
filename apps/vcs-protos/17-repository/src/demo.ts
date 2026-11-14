/** The commit sequence the Durable Object runs (and the Node test runs to compare ids). */
import { commit, writeFiles } from "./commands.js";
import type { Repository } from "./object-store.js";

const enc = new TextEncoder();
const who = (t: number) => ({
  name: "A U Thor",
  email: "a@example.com",
  when: 1700000000 + t,
  tz: "+0000",
});

export async function demoCommits(repo: Repository): Promise<void> {
  let parent: string | undefined;
  for (let i = 0; i < 4; i++) {
    const tree = await writeFiles(repo, {
      "a.txt": enc.encode(`v${i}\n`),
      "dir/b.txt": enc.encode("b\n"),
    });
    const c = await commit(repo, {
      ref: "refs/heads/main",
      tree,
      parents: parent ? [parent] : [],
      author: who(i * 60),
      message: `commit ${i}\n`,
    });
    if (!c.result.ok) throw new Error("commit rejected");
    parent = c.oid;
  }
}
