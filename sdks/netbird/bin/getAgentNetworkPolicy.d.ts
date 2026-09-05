import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getAgentNetworkPolicy(args?: GetAgentNetworkPolicyArgs, opts?: pulumi.InvokeOptions): Promise<GetAgentNetworkPolicyResult>;
/**
 * A collection of arguments for invoking getAgentNetworkPolicy.
 */
export interface GetAgentNetworkPolicyArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getAgentNetworkPolicy.
 */
export interface GetAgentNetworkPolicyResult {
    readonly budgetLimit: outputs.GetAgentNetworkPolicyBudgetLimit;
    readonly description: string;
    readonly destinationProviderIds: string[];
    readonly enabled: boolean;
    readonly guardrailIds: string[];
    readonly id: string;
    readonly name: string;
    readonly sourceGroups: string[];
    readonly tokenLimit: outputs.GetAgentNetworkPolicyTokenLimit;
}
export declare function getAgentNetworkPolicyOutput(args?: GetAgentNetworkPolicyOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetAgentNetworkPolicyResult>;
/**
 * A collection of arguments for invoking getAgentNetworkPolicy.
 */
export interface GetAgentNetworkPolicyOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getAgentNetworkPolicy.d.ts.map