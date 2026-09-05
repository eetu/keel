import * as pulumi from "@pulumi/pulumi";
export declare function getScim(args?: GetScimArgs, opts?: pulumi.InvokeOptions): Promise<GetScimResult>;
/**
 * A collection of arguments for invoking getScim.
 */
export interface GetScimArgs {
    id?: string;
    providerName?: string;
}
/**
 * A collection of values returned by getScim.
 */
export interface GetScimResult {
    readonly enabled: boolean;
    readonly groupPrefixes: string[];
    readonly id: string;
    readonly lastSyncedAt: string;
    readonly providerName: string;
    readonly userGroupPrefixes: string[];
}
export declare function getScimOutput(args?: GetScimOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetScimResult>;
/**
 * A collection of arguments for invoking getScim.
 */
export interface GetScimOutputArgs {
    id?: pulumi.Input<string | undefined>;
    providerName?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getScim.d.ts.map