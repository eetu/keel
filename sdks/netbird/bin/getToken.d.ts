import * as pulumi from "@pulumi/pulumi";
export declare function getToken(args: GetTokenArgs, opts?: pulumi.InvokeOptions): Promise<GetTokenResult>;
/**
 * A collection of arguments for invoking getToken.
 */
export interface GetTokenArgs {
    id?: string;
    name?: string;
    userId: string;
}
/**
 * A collection of values returned by getToken.
 */
export interface GetTokenResult {
    readonly createdAt: string;
    readonly expirationDate: string;
    readonly id: string;
    readonly lastUsed: string;
    readonly name: string;
    readonly userId: string;
}
export declare function getTokenOutput(args: GetTokenOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetTokenResult>;
/**
 * A collection of arguments for invoking getToken.
 */
export interface GetTokenOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
    userId: pulumi.Input<string>;
}
//# sourceMappingURL=getToken.d.ts.map