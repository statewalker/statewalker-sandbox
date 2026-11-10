/** git files: a FilesApi rooted at `.git` (packs and loose objects in `objects/`) and X5's filesRefDb. */
import type { FilesApi } from "@statewalker/webrun-files";
import { gitObjects } from "../../09-git-objects/src/git-objects.js";
import { filesStagingStore } from "../../09-git-objects/src/staging.js";
import { filesRefDb, type RefFiles } from "../../10-ref-transactions/src/files-ref-db.js";
import { composedStore } from "./composed-store.js";
import type { Repository, StoreOptions } from "./object-store.js";

export async function filesRepository(
  files: FilesApi,
  refFiles: RefFiles,
  opts: StoreOptions & { objectsDir?: string } = {},
): Promise<Repository> {
  const objectsDir = opts.objectsDir ?? "/objects";
  const loose = gitObjects(filesStagingStore(files, objectsDir));
  return {
    // X6r's database already reads the loose objects of this directory
    objects: await composedStore(files, objectsDir, loose, { ...opts, looseOnPackFiles: true }),
    refs: filesRefDb(refFiles),
  };
}
