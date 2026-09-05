import * as pulumi from "@pulumi/pulumi";
export declare function getIdentityProvider(args?: GetIdentityProviderArgs, opts?: pulumi.InvokeOptions): Promise<GetIdentityProviderResult>;
/**
 * A collection of arguments for invoking getIdentityProvider.
 */
export interface GetIdentityProviderArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getIdentityProvider.
 */
export interface GetIdentityProviderResult {
    readonly clientId: string;
    readonly id: string;
    readonly issuer: string;
    readonly name: string;
    readonly type: string;
}
export declare function getIdentityProviderOutput(args?: GetIdentityProviderOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetIdentityProviderResult>;
/**
 * A collection of arguments for invoking getIdentityProvider.
 */
export interface GetIdentityProviderOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getIdentityProvider.d.ts.map