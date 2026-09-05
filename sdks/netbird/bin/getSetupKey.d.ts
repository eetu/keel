import * as pulumi from "@pulumi/pulumi";
export declare function getSetupKey(args?: GetSetupKeyArgs, opts?: pulumi.InvokeOptions): Promise<GetSetupKeyResult>;
/**
 * A collection of arguments for invoking getSetupKey.
 */
export interface GetSetupKeyArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getSetupKey.
 */
export interface GetSetupKeyResult {
    readonly allowExtraDnsLabels: boolean;
    readonly autoGroups: string[];
    readonly ephemeral: boolean;
    readonly expires: string;
    readonly id: string;
    readonly lastUsed: string;
    readonly name: string;
    readonly revoked: boolean;
    readonly state: string;
    readonly type: string;
    readonly updatedAt: string;
    readonly usageLimit: number;
    readonly usedTimes: number;
    readonly valid: boolean;
}
export declare function getSetupKeyOutput(args?: GetSetupKeyOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetSetupKeyResult>;
/**
 * A collection of arguments for invoking getSetupKey.
 */
export interface GetSetupKeyOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getSetupKey.d.ts.map