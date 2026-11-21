// Runtime-agnostic entry: the REST app, the MCP handler, the REST client and the types. Nothing
// reachable from here imports a Node built-in (a test checks), so a Worker, Bun or Deno server can
// import it and serve any JobManager implementation.
export { JobsClient, JobsClientError } from "./client.ts";
export { isSafeId } from "./ids.ts";
export {
  createJobsMcpHandler,
  createJobsMcpServer,
  FOLLOW_TIMEOUT_MS,
  type JobsMcpHandler,
  type JobsMcpOptions,
  MAX_FOLLOW_TIMEOUT_MS,
  MAX_PAGE,
  MAX_WAIT_MS,
} from "./mcp.ts";
export {
  createJobsApp,
  createJobsHandler,
  type JobsAppOptions,
  type JobsHandler,
  type JobsHandlerOptions,
} from "./rest.ts";
export * from "./types.ts";
export { type JobExpectations, matches, results, type VerifyResult, verifyJob } from "./verify.ts";
