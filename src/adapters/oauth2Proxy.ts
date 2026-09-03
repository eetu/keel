/**
 * The forward-auth gate's vocabulary.
 *
 * oauth2-proxy's paths are an interface three other things dial: the proxy asks
 * one of them per request, turns a `no` into a fetch of the second, the page that
 * comes back submits itself to the third, and the identity provider is handed the
 * fourth as the client's registered redirect URI. All four live here, so the
 * gate's own configuration, the middleware that queries it and the page that
 * submits to it cannot each carry a copy of a path only one of them owns.
 *
 * `gateRole` is how the rest of the repository reads them: an entry claims it,
 * and the proxy asks the role rather than this module — so nothing outside here
 * knows the gate is oauth2-proxy.
 */

import { type GateRole } from "../config/spec";

/** Answers the proxy's yes/no query about a request. */
const AUTH_PATH = "/oauth2/auth";
/** The page a `no` is turned into, which the browser is shown in place of a 401. */
const SIGN_IN_PATH = "/oauth2/sign_in";
/** Begins the OIDC flow. What the sign-in page submits itself to. */
const START_PATH = "/oauth2/start";
/** Where the identity provider sends the browser back, and so the client's redirect URI. */
const CALLBACK_PATH = "/oauth2/callback";

/**
 * How the gate refuses. It answers a forward-auth query for an unauthenticated
 * request with 401, and a proxy that copies that status to the client shows the
 * browser a bare error page — so catching exactly this status is what turns the
 * gate into a login.
 */
const CHALLENGE_STATUS = 401;

/**
 * What the gate proves about a request, once. `X-Auth-Request-User` carries
 * Kanidm's `preferred_username`, so a downstream service that trusts the header
 * matches its own usernames rather than email addresses. The proxy forwards
 * exactly these and deletes anything a client sent under the same names.
 */
const RESPONSE_HEADERS = ["X-Auth-Request-User", "X-Auth-Request-Email"] as const;

/**
 * The gate as a role, for the entry that is it.
 *
 * The port is the entry's own, and the forward-auth address is loopback because
 * the gate shares the host's network stack: the proxy's query never leaves the
 * machine.
 */
export function gateRole(port: number): GateRole {
  return {
    forwardAuth: `http://127.0.0.1:${port}${AUTH_PATH}`,
    // The return address is encoded: it is a value inside the query string of
    // another URL.
    challenge: (returnTo) => `${SIGN_IN_PATH}?rd=${encodeURIComponent(returnTo)}`,
    challengeStatus: CHALLENGE_STATUS,
    submit: (origin) => `${origin}${START_PATH}`,
    callback: (origin) => `${origin}${CALLBACK_PATH}`,
    responseHeaders: RESPONSE_HEADERS,
  };
}

/**
 * The directory oauth2-proxy is pointed at, mounted into the container at the
 * same path it has on the host.
 *
 * Only `sign_in.html` is written to it. oauth2-proxy takes each template from a
 * custom directory only when that file is present and uses its embedded default
 * otherwise, so the error page stays the stock one — at the cost of one logged
 * line per missing file at startup, which reads like a failure and is not.
 */
export const OAUTH2_TEMPLATES_DIR = "/etc/oauth2-proxy/templates";
export const SIGN_IN_TEMPLATE_PATH = `${OAUTH2_TEMPLATES_DIR}/sign_in.html`;

/**
 * oauth2-proxy's sign-in page, replacing the built-in one.
 *
 * A gated route's 401 reaches this page through the proxy's error handling, and
 * that handling preserves the original status: whatever the sign-in handler
 * answers with is delivered to the browser as a 401 body, so the handler's own
 * redirect never moves anyone. A GET form submitted on load moves the browser
 * under any status code, and carries `rd` through to the start endpoint — which
 * is what returns the visitor to the vhost they were heading for once the
 * identity provider has answered.
 *
 * `{{.Redirect}}` is oauth2-proxy's template variable, not a value this renders:
 * it is left in the output for the proxy to fill with the `rd` the middleware
 * asked for.
 */
export function signInTemplate(submitUrl: string): string {
  return `${[
    "<!DOCTYPE html>",
    "<html>",
    '<head><meta charset="utf-8"><title>Logging in...</title></head>',
    '<body onload="document.forms[0].submit()">',
    `<form method="GET" action="${submitUrl}">`,
    '  <input type="hidden" name="rd" value="{{.Redirect}}">',
    '  <noscript><button type="submit">Login with Kanidm</button></noscript>',
    "</form>",
    "</body>",
    "</html>",
  ].join("\n")}\n`;
}
