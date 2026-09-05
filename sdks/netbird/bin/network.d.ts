import * as pulumi from "@pulumi/pulumi";
export declare class Network extends pulumi.CustomResource {
    /**
     * Get an existing Network resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: NetworkState, opts?: pulumi.CustomResourceOptions): Network;
    /**
     * Returns true if the given object is an instance of Network.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Network;
    /**
     * Network Description
     */
    readonly description: pulumi.Output<string>;
    /**
     * Network Name
     */
    readonly name: pulumi.Output<string>;
    /**
     * Policy IDs associated with resources inside this Network
     */
    readonly policies: pulumi.Output<string[]>;
    /**
     * Network Resource IDs
     */
    readonly resources: pulumi.Output<string[]>;
    /**
     * Network Router IDs
     */
    readonly routers: pulumi.Output<string[]>;
    /**
     * Create a Network resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: NetworkArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Network resources.
 */
export interface NetworkState {
    /**
     * Network Description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Network Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Policy IDs associated with resources inside this Network
     */
    policies?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Network Resource IDs
     */
    resources?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Network Router IDs
     */
    routers?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
/**
 * The set of arguments for constructing a Network resource.
 */
export interface NetworkArgs {
    /**
     * Network Description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Network Name
     */
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=network.d.ts.map