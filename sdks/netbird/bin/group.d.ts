import * as pulumi from "@pulumi/pulumi";
export declare class Group extends pulumi.CustomResource {
    /**
     * Get an existing Group resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: GroupState, opts?: pulumi.CustomResourceOptions): Group;
    /**
     * Returns true if the given object is an instance of Group.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Group;
    /**
     * Group issued by
     */
    readonly issued: pulumi.Output<string>;
    /**
     * Group name identifier
     */
    readonly name: pulumi.Output<string>;
    /**
     * List of peers ids
     */
    readonly peers: pulumi.Output<string[]>;
    /**
     * List of network resource ids
     */
    readonly resources: pulumi.Output<string[]>;
    /**
     * Create a Group resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: GroupArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Group resources.
 */
export interface GroupState {
    /**
     * Group issued by
     */
    issued?: pulumi.Input<string | undefined>;
    /**
     * Group name identifier
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * List of peers ids
     */
    peers?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * List of network resource ids
     */
    resources?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
/**
 * The set of arguments for constructing a Group resource.
 */
export interface GroupArgs {
    /**
     * Group name identifier
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * List of peers ids
     */
    peers?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * List of network resource ids
     */
    resources?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
//# sourceMappingURL=group.d.ts.map