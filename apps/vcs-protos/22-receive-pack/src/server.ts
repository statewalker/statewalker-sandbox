/** X8b — git's receive-pack as a fetch handler — red stub. */
import type { Repository } from "../../17-repository/src/object-store.js";
export interface PushCommand {
  ref: string;
  old: string;
  new: string;
}
export interface ReceivePackOptions {
  agent?: string;
  maxRequestBytes?: number;
  /** refuse the whole push: a message, or undefined to accept */
  preReceive?: (commands: PushCommand[]) => Promise<string | undefined>;
  /** refuse one ref: a message, or undefined to accept */
  update?: (command: PushCommand) => Promise<string | undefined>;
}
export function receivePackHandler(
  _repo: Repository,
  _opts: ReceivePackOptions = {},
): (req: Request) => Promise<Response> {
  return async () => {
    throw new Error("not implemented");
  };
}
/** upload-pack (X8a) and receive-pack behind one handler */
export function gitHandler(
  _repo: Repository,
  _opts: ReceivePackOptions = {},
): (req: Request) => Promise<Response> {
  return async () => {
    throw new Error("not implemented");
  };
}
