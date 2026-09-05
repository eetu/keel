import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class AgentNetworkGuardrail extends pulumi.CustomResource {
    /**
     * Get an existing AgentNetworkGuardrail resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: AgentNetworkGuardrailState, opts?: pulumi.CustomResourceOptions): AgentNetworkGuardrail;
    /**
     * Returns true if the given object is an instance of AgentNetworkGuardrail.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is AgentNetworkGuardrail;
    /**
     * Optional human-readable description
     */
    readonly description: pulumi.Output<string>;
    /**
     * Restrict which catalog models are allowed
     */
    readonly modelAllowlist: pulumi.Output<outputs.AgentNetworkGuardrailModelAllowlist>;
    /**
     * Display name for the guardrail
     */
    readonly name: pulumi.Output<string>;
    /**
     * Request/response prompt capture settings
     */
    readonly promptCapture: pulumi.Output<outputs.AgentNetworkGuardrailPromptCapture>;
    /**
     * Create a AgentNetworkGuardrail resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: AgentNetworkGuardrailArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering AgentNetworkGuardrail resources.
 */
export interface AgentNetworkGuardrailState {
    /**
     * Optional human-readable description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Restrict which catalog models are allowed
     */
    modelAllowlist?: pulumi.Input<inputs.AgentNetworkGuardrailModelAllowlist | undefined>;
    /**
     * Display name for the guardrail
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Request/response prompt capture settings
     */
    promptCapture?: pulumi.Input<inputs.AgentNetworkGuardrailPromptCapture | undefined>;
}
/**
 * The set of arguments for constructing a AgentNetworkGuardrail resource.
 */
export interface AgentNetworkGuardrailArgs {
    /**
     * Optional human-readable description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Restrict which catalog models are allowed
     */
    modelAllowlist: pulumi.Input<inputs.AgentNetworkGuardrailModelAllowlist>;
    /**
     * Display name for the guardrail
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Request/response prompt capture settings
     */
    promptCapture: pulumi.Input<inputs.AgentNetworkGuardrailPromptCapture>;
}
//# sourceMappingURL=agentNetworkGuardrail.d.ts.map