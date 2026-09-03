/**
 * The vault fields a CIFS mount authenticates with.
 *
 * Committed, because none of it names an installation: the item and the field
 * names are what a stranger creates, and which vault holds them is
 * `installation.ts`'s.
 * Values never appear here — they are read at deploy time, sealed for the host,
 * and land as a credentials file the mount unit points at.
 *
 * Two accounts rather than one per share, because a consumer NAS caps its
 * account count long before a fleet runs out of shares. So the pair a share uses
 * follows from its own `readOnly`: a share that is only ever read authenticates
 * as an account that cannot write to it, and a write is then a change to the
 * declaration rather than a permission that was there all along.
 */

/** The vault item both pairs live on. The same one the backup's share login uses. */
export const SHARE_VAULT_ITEM = "cifs";

/**
 * Credentials-file variable -> vault field, per access level.
 *
 * `username` and `password` are the kernel helper's own key names: the file it
 * reads is `username=…` / `password=…`, which is exactly the body an env file is,
 * so a share's login travels the same sealed path a service's environment does
 * and needs no mechanism of its own.
 */
export const SHARE_CREDENTIAL_FIELDS = {
  readOnly: { username: "readonly_username", password: "readonly_password" },
  readWrite: { username: "readwrite_username", password: "readwrite_password" },
} as const;
