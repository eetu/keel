/**
 * How a caller passes what a provider receives.
 *
 * A provider's methods are handed fully-resolved values, so every `*Inputs` type
 * is plain data. A resource *constructor* has to accept an `Output` in any
 * position as well — that is how a resolved image digest reaches a quadlet's
 * body and a sealed blob reaches a secret file — so the class takes `Args<T>`.
 *
 * Types only. Nothing here exists at runtime, so nothing here can be captured by
 * a serialised closure.
 */

import type * as pulumi from "@pulumi/pulumi";

export type Args<T> = { [K in keyof T]: pulumi.Input<T[K]> };
