/** git's upload-pack (protocol v2) as a fetch handler (X8a) — red stub. */
import type { Repository } from "../../17-repository/src/object-store.js";
export function uploadPackHandler(_repo: Repository): (req: Request) => Promise<Response> {
  return async () => {
    throw new Error("not implemented");
  };
}
