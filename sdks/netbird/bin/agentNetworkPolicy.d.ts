import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class AgentNetworkPolicy extends pulumi.CustomResource {
    /**
     * Get an existing AgentNetworkPolicy resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: AgentNetworkPolicyState, opts?: pulumi.CustomResourceOptions): AgentNetworkPolicy;
    /**
     * Returns true if the given object is an instance of AgentNetworkPolicy.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is AgentNetworkPolicy;
    /**
     * Per-policy USD spend cap
     */
    readonly budgetLimit: pulumi.Output<outputs.AgentNetworkPolicyBudgetLimit>;
    /**
     * Optional human-readable description
     */
    readonly description: pulumi.Output<string>;
    /**
     * Agent Network provider IDs the source groups can reach. Must contain at least one non-empty provider ID.
     */
    readonly destinationProviderIds: pulumi.Output<string[]>;
    /**
     * Whether the policy is enabled
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Agent Network guardrail IDs attached to this policy
     */
    readonly guardrailIds: pulumi.Output<string[]>;
    /**
     * Display name for the policy
     */
    readonly name: pulumi.Output<string>;
    /**
     * NetBird group IDs whose members may call the destination providers. Must contain at least one non-empty group ID.
     */
    readonly sourceGroups: pulumi.Output<string[]>;
    /**
     * Per-policy token cap
     */
    readonly tokenLimit: pulumi.Output<outputs.AgentNetworkPolicyTokenLimit>;
    /**
     * Create a AgentNetworkPolicy resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: AgentNetworkPolicyArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering AgentNetworkPolicy resources.
 */
export interface AgentNetworkPolicyState {
    /**
     * Per-policy USD spend cap
     */
    budgetLimit?: pulumi.Input<inputs.AgentNetworkPolicyBudgetLimit | undefined>;
    /**
     * Optional human-readable description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Agent Network provider IDs the source groups can reach. Must contain at least one non-empty provider ID.
     */
    destinationProviderIds?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Whether the policy is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Agent Network guardrail IDs attached to this policy
     */
    guardrailIds?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Display name for the policy
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * NetBird group IDs whose members may call the destination providers. Must contain at least one non-empty group ID.
     */
    sourceGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Per-policy token cap
     */
    tokenLimit?: pulumi.Input<inputs.AgentNetworkPolicyTokenLimit | undefined>;
}
/**
 * The set of arguments for constructing a AgentNetworkPolicy resource.
 */
export interface AgentNetworkPolicyArgs {
    /**
     * Per-policy USD spend cap
     */
    budgetLimit?: pulumi.Input<inputs.AgentNetworkPolicyBudgetLimit | undefined>;
    /**
     * Optional human-readable description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Agent Network provider IDs the source groups can reach. Must contain at least one non-empty provider ID.
     */
    destinationProviderIds: pulumi.Input<pulumi.Input<string>[]>;
    /**
     * Whether the policy is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Agent Network guardrail IDs attached to this policy
     */
    guardrailIds?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Display name for the policy
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * NetBird group IDs whose members may call the destination providers. Must contain at least one non-empty group ID.
     */
    sourceGroups: pulumi.Input<pulumi.Input<string>[]>;
    /**
     * Per-policy token cap
     */
    tokenLimit?: pulumi.Input<inputs.AgentNetworkPolicyTokenLimit | undefined>;
}
//# sourceMappingURL=agentNetworkPolicy.d.ts.map