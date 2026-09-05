import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class Policy extends pulumi.CustomResource {
    /**
     * Get an existing Policy resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: PolicyState, opts?: pulumi.CustomResourceOptions): Policy;
    /**
     * Returns true if the given object is an instance of Policy.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Policy;
    /**
     * Policy Description
     */
    readonly description: pulumi.Output<string>;
    /**
     * Policy enabled
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Policy Name
     */
    readonly name: pulumi.Output<string>;
    readonly rules: pulumi.Output<outputs.PolicyRule[] | undefined>;
    /**
     * Posture checks associated with policy
     */
    readonly sourcePostureChecks: pulumi.Output<string[]>;
    /**
     * Create a Policy resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: PolicyArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Policy resources.
 */
export interface PolicyState {
    /**
     * Policy Description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Policy enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Policy Name
     */
    name?: pulumi.Input<string | undefined>;
    rules?: pulumi.Input<pulumi.Input<inputs.PolicyRule>[] | undefined>;
    /**
     * Posture checks associated with policy
     */
    sourcePostureChecks?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
/**
 * The set of arguments for constructing a Policy resource.
 */
export interface PolicyArgs {
    /**
     * Policy Description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Policy enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Policy Name
     */
    name?: pulumi.Input<string | undefined>;
    rules?: pulumi.Input<pulumi.Input<inputs.PolicyRule>[] | undefined>;
    /**
     * Posture checks associated with policy
     */
    sourcePostureChecks?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
//# sourceMappingURL=policy.d.ts.map