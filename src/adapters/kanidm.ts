/**
 * Kanidm's dialect: where a client's issuer lives, and which account registers
 * one.
 *
 * Nothing here is keyed on a service being called kanidm. These are the facts
 * about the product that more than one place has to agree on, written in one
 * module and read through the role the identity provider's entry claims.
 */

import type { IdentityRole } from "../config/spec";

/**
 * The issuer of an OAuth2 client registered with Kanidm: a path under the
 * server's own origin, named for the client. Both halves are handed in — the
 * origin by the identity provider's entry, the client id by the entry that
 * registers one — so a client and the issuer it asks cannot drift into naming
 * different clients.
 */
export function oidcIssuer(origin: string, clientId: string): string {
  return `${origin}/oauth2/openid/${clientId}`;
}

/**
 * The account that manages persons, groups and OAuth2 clients — `admin` is for
 * the server's own configuration and cannot. Its password is whatever
 * `recover-account` last printed: the server image is distroless and its CLI
 * wants a terminal, so the `scripting` form, which answers in JSON over the
 * server's admin socket, is the one a deploy can drive.
 */
const ADMIN_ACCOUNT = "idm_admin";

/** Kanidm as a role, for the entry that is it. */
export const KANIDM_IDENTITY: IdentityRole = {
  issuer: oidcIssuer,
  admin: {
    account: ADMIN_ACCOUNT,
    passwordField: `${ADMIN_ACCOUNT}_password`,
    recover: ["/sbin/kanidmd", "scripting", "recover-account", ADMIN_ACCOUNT],
  },
};
