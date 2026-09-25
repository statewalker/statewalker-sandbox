# @theia-shell/theia-files-api

A Theia extension that serves a `@statewalker/webrun-files` `FilesApi` as the
`file:` file system of a browser-only Theia app (`FilesApiFileSystemProvider`),
and opens its root as the workspace.

## DI keys

| Key | Type | Default | Purpose |
|---|---|---|---|
| `FilesApiSource` | `() => FilesApi \| Promise<FilesApi>` | an empty `MemFilesApi` | the FilesApi shown |
| `FilesApiWorkspaceRoot` | `string` | `file:///` | the workspace opened when none was |
| `FilesApiRootLabel` | `string` | `/` | the root's label in the explorer |
| `FilesApiChanges` | `Event<readonly FilesApiChange[]>` | unbound | changes the provider cannot see (a mount appearing, a filter changing); when bound, forwarded to Theia as file changes |

`FilesApi` has no watch API: the provider reports the changes it makes itself,
and `FilesApiChanges` is how anything else that changes the tree tells Theia.

## Red / green

- **External changes** (`tests/files-api-changes.test.ts`). Red: 2 of 2
  (`toFileChanges is not a function`). Green: 2 of 2; the package's 23 of 23.
