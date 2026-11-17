// PROTOTYPE. flue-capfs-do's Workspace cell (store, Biscuit authority, files gate), plus the
// owner side of two harness tools. Members live in `/.harness/<project>/access`, outside every
// session's rights here (the harness's real system folder is hidden by the gate, #80).

import { SqlFs } from "../../flue-capfs-do/src/sql-fs.ts";
import { Workspace as CapFsWorkspace } from "../../flue-capfs-do/src/workspace.ts";

const accessFile = (project: string) => `/.harness/${project}/access`;

export class Workspace extends CapFsWorkspace {
  #store: SqlFs;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#store = new SqlFs(ctx.storage.sql);
  }

  async #members(project: string): Promise<Record<string, string>> {
    const file = accessFile(project);
    return (await this.#store.exists(file)) ? JSON.parse(await this.#store.readFile(file)) : {};
  }

  /** A harness tool, run here with the owner's rights once the caller's capability is live. */
  async harnessTool(entry: string, project: string, token: string, args: Record<string, unknown>) {
    // The session must be live and see the project: the same gate a file call goes through.
    await this.fsCall(token, { op: "readdir", path: `/${project}` });
    const members = await this.#members(project);
    if (entry === "members.list") return { members };
    if (entry === "members.add") {
      members[String(args.user)] = String(args.role);
      const file = accessFile(project);
      if (!(await this.#store.exists(`/.harness/${project}`)))
        await this.#store.mkdir(`/.harness/${project}`, { recursive: true });
      await this.#store.writeFile(file, JSON.stringify(members));
      return { members };
    }
    throw new Error(`ENOSYS: no harness tool '${entry}'`);
  }
}
