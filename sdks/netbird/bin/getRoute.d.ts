import * as pulumi from "@pulumi/pulumi";
export declare function getRoute(args?: GetRouteArgs, opts?: pulumi.InvokeOptions): Promise<GetRouteResult>;
/**
 * A collection of arguments for invoking getRoute.
 */
export interface GetRouteArgs {
    id?: string;
    networkId?: string;
}
/**
 * A collection of values returned by getRoute.
 */
export interface GetRouteResult {
    readonly accessControlGroups: string[];
    readonly description: string;
    readonly domains: string[];
    readonly enabled: boolean;
    readonly groups: string[];
    readonly id: string;
    readonly keepRoute: boolean;
    readonly masquerade: boolean;
    readonly metric: number;
    readonly network: string;
    readonly networkId: string;
    readonly networkType: string;
    readonly peer: string;
    readonly peerGroups: string[];
    readonly skipAutoApply: boolean;
}
export declare function getRouteOutput(args?: GetRouteOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetRouteResult>;
/**
 * A collection of arguments for invoking getRoute.
 */
export interface GetRouteOutputArgs {
    id?: pulumi.Input<string | undefined>;
    networkId?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getRoute.d.ts.map