# @theia-shell/theia-secret-vault

A Theia extension that gives a browser-only app a real secret store. Browser-only
Theia binds `KeyStoreService` (behind `CredentialsService`, and VS Code
extensions' `context.secrets`) to a stub that silently drops every secret; this
package rebinds it to an encrypted vault.

## Files

The vault lives in a folder of a `FilesApi` (the app's main storage, `/.shell`):

`vault.key.json` — the data key, locked by the password (no secret in clear):

```json
{
  "version": 1,
  "id": "<random uuid>",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64>" },
  "wrap": { "name": "AES-GCM", "iv": "<b64>" },
  "wrappedKey": "<b64>"
}
```

`secrets.json` — `{ "version": 1, "iv": "<b64>", "data": "<b64>" }`: the whole
map of secrets, names and values, as one AES-GCM ciphertext bound to the vault
`id`. A fresh IV on every write; a tampered or swapped file fails to decrypt and
is reported, never silently emptied. Writes re-read the file first, so two tabs
do not erase each other's secrets.

## Keys and unlocking

- The **data key** (AES-GCM 256) encrypts `secrets.json`. Unlocked, it is held
  non-extractable: code on the page can use it, never read it.
- The **password key** (PBKDF2 of the password) only wraps and unwraps the data key.
- At start: a remembered key unlocks silently; otherwise a dialog asks for the
  password (or a new one, twice, when there is no vault yet), with
  *Remember on this device* and *Skip*. *Remember* keeps the password key, as a
  non-extractable `CryptoKey`, in IndexedDB (`theia-shell-vault-keys`) — never
  the password text.
- A vault on non-persistent storage (in-memory main) is a session vault: a random
  key, no password prompt.

Commands (category *Secrets*): Unlock, Lock, Change Password (re-wraps the data
key only), Forget Remembered Password, Reset Vault (new key, secrets lost — for a
forgotten password).

## For an app

Bind `VaultLocation` to `() => Promise<{ files, dir, persistent }>`. The default
is an in-memory, non-persistent location.

## Limits

Any script running on the app's origin can, while the vault is unlocked, ask it
to decrypt (it cannot extract the keys). At rest, without the password or a
remembered key, the secrets are unreadable. A remembered key trades that at-rest
protection on this device for no prompt.

## Red / green

- **`SecretVault`** (`tests/secret-vault.test.ts`). Red: the module missing.
  Green: 13 of 13 — create/unlock, wrong password, exact passwords, no plaintext
  on disk, change password, remembered non-extractable key, reset, tampered and
  swapped files, locked reads/writes, two tabs, session vault, lock events.
- **`VaultKeyStore`** (`tests/vault-key-store.test.ts`). Red: the module missing.
  Green: 4 of 4; the package's 17 of 17.
- The dialog, commands and `KeyStoreService` rebind are covered end to end in
  `app/tests/vault.spec.ts` (Task 9).
