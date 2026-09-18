/**
 * Where the registrar's API token lives, for the three things that need it.
 *
 * The proxy reads it to answer a DNS-01 challenge, the deploy machine reads it
 * to configure the Cloudflare provider before the program is evaluated, and the
 * board reads it to keep its WAN-facing records current. One item, one field,
 * named once — a second copy of these strings is a rotation that fixes two
 * callers out of three.
 *
 * Committed, because a stranger adopting this creates the same item under the
 * same name. Which *vault* holds it is the installation's to say, and stays on
 * `INSTALLATION.vault`.
 */
export const CLOUDFLARE_ITEM = "cloudflare";

/** The login item's password field is the API token, which is where it has always been. */
export const CLOUDFLARE_FIELD = "password";
