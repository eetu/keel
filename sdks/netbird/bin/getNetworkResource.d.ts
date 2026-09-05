import * as pulumi from "@pulumi/pulumi";
export declare function getNetworkResource(args: GetNetworkResourceArgs, opts?: pulumi.InvokeOptions): Promise<GetNetworkResourceResult>;
/**
 * A collection of arguments for invoking getNetworkResource.
 */
export interface GetNetworkResourceArgs {
    id?: string;
    name?: string;
    networkId: string;
}
/**
 * A collection of values returned by getNetworkResource.
 */
export interface GetNetworkResourceResult {
    readonly address: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly groups: string[];
    readonly id: string;
    readonly name: string;
    readonly networkId: string;
}
export declare function getNetworkResourceOutput(args: GetNetworkResourceOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetNetworkResourceResult>;
/**
 * A collection of arguments for invoking getNetworkResource.
 */
export interface GetNetworkResourceOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
    networkId: pulumi.Input<string>;
}
//# sourceMappingURL=getNetworkResource.d.ts.map