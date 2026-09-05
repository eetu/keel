import * as pulumi from "@pulumi/pulumi";
export declare function getNetworkRouter(args: GetNetworkRouterArgs, opts?: pulumi.InvokeOptions): Promise<GetNetworkRouterResult>;
/**
 * A collection of arguments for invoking getNetworkRouter.
 */
export interface GetNetworkRouterArgs {
    id: string;
    networkId: string;
}
/**
 * A collection of values returned by getNetworkRouter.
 */
export interface GetNetworkRouterResult {
    readonly enabled: boolean;
    readonly id: string;
    readonly masquerade: boolean;
    readonly metric: number;
    readonly networkId: string;
    readonly peer: string;
    readonly peerGroups: string[];
}
export declare function getNetworkRouterOutput(args: GetNetworkRouterOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetNetworkRouterResult>;
/**
 * A collection of arguments for invoking getNetworkRouter.
 */
export interface GetNetworkRouterOutputArgs {
    id: pulumi.Input<string>;
    networkId: pulumi.Input<string>;
}
//# sourceMappingURL=getNetworkRouter.d.ts.map