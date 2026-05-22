/**
 * Thrown by `createWorkbench` when `onSecretRequest` rejects or resolves with
 * an empty value — boot gating must be atomic, so no partial workbench is
 * exposed when a required secret is missing.
 */
export class WorkbenchSecretMissingError extends Error {
  readonly secretName: string;

  constructor(secretName: string, options?: { cause?: unknown }) {
    super(`Required secret "${secretName}" was not provided.`, options);
    this.name = "WorkbenchSecretMissingError";
    this.secretName = secretName;
  }
}
