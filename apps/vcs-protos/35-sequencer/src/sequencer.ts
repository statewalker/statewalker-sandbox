/** X15 — git's sequencer state (stubs) */
import type { FilesApi } from "@statewalker/webrun-files";
import type { Person } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import type { Worktree } from "../../34-index/src/worktree.js";

export interface Session {
  repo: Repository;
  /** the .git directory: state files and the index */
  git: FilesApi;
  wt: Worktree;
  author: Person;
  committer: Person;
}
export interface OpResult {
  status: "clean" | "fast-forward" | "up-to-date" | "conflict" | "stopped" | "done";
  commit?: string;
}
const todo = (): never => {
  throw new Error("not implemented");
};
export async function merge(_s: Session, _ref: string): Promise<OpResult> {
  return todo();
}
export async function cherryPick(_s: Session, _commit: string): Promise<OpResult> {
  return todo();
}
export async function rebase(_s: Session, _upstream: string): Promise<OpResult> {
  return todo();
}
export async function commitOp(_s: Session): Promise<OpResult> {
  return todo();
}
export async function continueOp(_s: Session): Promise<OpResult> {
  return todo();
}
export async function abortOp(_s: Session): Promise<OpResult> {
  return todo();
}
export async function addAllOp(_s: Session): Promise<void> {
  return todo();
}
