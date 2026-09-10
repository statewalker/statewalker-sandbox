# @statewalker/mvc-blueprint

## Known upstream dependencies

This app's command-override rule reads `cmd.claimed`, which `@statewalker/shared-commands@0.2.1` sets at run time but declares only on its unexported `CommandInternal` type (see its `src/types.ts`); the public `Command` type does not carry it. The contract guard in `B2-commands/tests/claimed-contract.test.ts` verifies this behaviour so a change upstream fails loudly.
