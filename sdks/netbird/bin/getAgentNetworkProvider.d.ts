import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getAgentNetworkProvider(args?: GetAgentNetworkProviderArgs, opts?: pulumi.InvokeOptions): Promise<GetAgentNetworkProviderResult>;
/**
 * A collection of arguments for invoking getAgentNetworkProvider.
 */
export interface GetAgentNetworkProviderArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getAgentNetworkProvider.
 */
export interface GetAgentNetworkProviderResult {
    readonly apiKey: string;
    readonly enabled: boolean;
    readonly extraValues: {
        [key: string]: string;
    };
    readonly id: string;
    readonly identityHeaderGroups: string;
    readonly identityHeaderUserId: string;
    readonly metadataDisabled: boolean;
    readonly models: outputs.GetAgentNetworkProviderModel[];
    readonly name: string;
    readonly providerId: string;
    readonly skipTlsVerification: boolean;
    readonly upstreamUrl: string;
}
export declare function getAgentNetworkProviderOutput(args?: GetAgentNetworkProviderOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetAgentNetworkProviderResult>;
/**
 * A collection of arguments for invoking getAgentNetworkProvider.
 */
export interface GetAgentNetworkProviderOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getAgentNetworkProvider.d.ts.map