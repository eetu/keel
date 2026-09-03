/**
 * The client half of an OIDC login, composed from whichever entry claims the
 * identity role.
 *
 * An application that runs its own flow needs four facts about its
 * registration: the issuer to discover, the client id it is registered as, the
 * secret the provider generated for it, and the redirect URI a browser is sent
 * back to. Three are ordinary environment. The fourth is a vault field, because
 * a client secret is a credential — and it is a field on the *provider's* item,
 * since the provider generates it and keeps it with its own credentials.
 *
 * This is a composition rather than one template's private detail. The four
 * variable names and the redirect path belong to whichever application reads
 * them, so a literal entry composes the same four under its own spelling; what
 * every entry shares is asking the role for the issuer instead of writing a URL
 * of its own, which is the only thing that stops a client and its issuer from
 * drifting into naming different clients.
 */

import { type SecretRef, type SetupContext } from "../spec";

/**
 * What one client's four facts are called in its own environment. The house's
 * applications share this spelling; a third-party client that reads its own is
 * handed a value of this type.
 */
export type OidcVariables = {
  issuer: string;
  clientId: string;
  /**
   * The variable the client secret arrives in. Named here and set nowhere near
   * here: it is a `secretEnv` entry, so the value reaches the container through
   * the sealed env file rather than as an `Environment=` line in the quadlet.
   */
  clientSecret: string;
  redirectUrl: string;
};

/** The spelling every application in this house reads. */
export const OIDC_VARIABLES: OidcVariables = {
  issuer: "OIDC_ISSUER",
  clientId: "OIDC_CLIENT_ID",
  clientSecret: "OIDC_CLIENT_SECRET",
  redirectUrl: "OIDC_REDIRECT_URL",
};

/**
 * Where the provider sends a browser back to. One path across the house's
 * applications, because it is a route in a shared backend rather than a choice
 * each one makes.
 */
export const OIDC_CALLBACK_PATH = "/auth/callback";

export type OidcClientOptions = {
  /** The registered client id. Defaults to the entry's own name. */
  clientId?: string;
  /** Under the entry's own origin. Defaults to `OIDC_CALLBACK_PATH`. */
  redirectPath?: string;
  /** For a client that reads its own spelling of the four. */
  variables?: OidcVariables;
};

/**
 * The three non-secret variables, from the resolved role and the entry's origin.
 *
 * Both URLs are built rather than stated: the issuer comes from the provider's
 * own vhost and the client id, and the redirect from this entry's vhost and the
 * callback path — so moving either vhost moves both, and a zone appears in
 * neither catalog.
 */
export function oidcClientEnv(
  context: SetupContext,
  options: OidcClientOptions = {},
): Record<string, string> {
  const { self, catalog, origin } = context;
  const identity = catalog.identity;
  if (identity === undefined) {
    throw new Error(
      `${self.name} runs an OIDC client of its own, and no deployed entry claims the ` +
        "identity role — there is no issuer for it to ask",
    );
  }
  const clientId = options.clientId ?? self.name;
  const variables = options.variables ?? OIDC_VARIABLES;
  return {
    [variables.issuer]: identity.role.issuer(origin(identity.spec), clientId),
    [variables.clientId]: clientId,
    [variables.redirectUrl]: `${origin()}${options.redirectPath ?? OIDC_CALLBACK_PATH}`,
  };
}

/**
 * Where a client's secret is read from: the item that holds the identity
 * provider's own credentials, under a field named for the client.
 *
 * The provider issues the secret and it cannot be set from outside, so a field
 * on the client's own item would be a field nobody ever fills. Which item that
 * is has to be handed in — a `secretEnv` entry is static, resolved before any
 * role is, so the provider cannot be asked at the point the reference is built.
 */
export function oidcClientSecretRef(identityItem: string, clientId: string): SecretRef {
  return { item: identityItem, field: `${clientId.replace(/-/g, "_")}_client_secret` };
}
