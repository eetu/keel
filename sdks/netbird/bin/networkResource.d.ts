import * as pulumi from "@pulumi/pulumi";
export declare class NetworkResource extends pulumi.CustomResource {
    /**
     * Get an existing NetworkResource resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: NetworkResourceState, opts?: pulumi.CustomResourceOptions): NetworkResource;
    /**
     * Returns true if the given object is an instance of NetworkResource.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is NetworkResource;
    /**
     * Network resource address (either a direct host like 1.1.1.1 or 1.1.1.1/32, or a subnet like 192.168.178.0/24, or domains like example.com and *.example.com)
     */
    readonly address: pulumi.Output<string>;
    /**
     * NetworkResource Description
     */
    readonly description: pulumi.Output<string>;
    /**
     * NetworkResource status
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Group IDs containing the resource
     */
    readonly groups: pulumi.Output<string[]>;
    /**
     * NetworkResource Name
     */
    readonly name: pulumi.Output<string>;
    /**
     * The unique identifier of a network
     */
    readonly networkId: pulumi.Output<string>;
    /**
     * Create a NetworkResource resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: NetworkResourceArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering NetworkResource resources.
 */
export interface NetworkResourceState {
    /**
     * Network resource address (either a direct host like 1.1.1.1 or 1.1.1.1/32, or a subnet like 192.168.178.0/24, or domains like example.com and *.example.com)
     */
    address?: pulumi.Input<string | undefined>;
    /**
     * NetworkResource Description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * NetworkResource status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Group IDs containing the resource
     */
    groups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * NetworkResource Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * The unique identifier of a network
     */
    networkId?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a NetworkResource resource.
 */
export interface NetworkResourceArgs {
    /**
     * Network resource address (either a direct host like 1.1.1.1 or 1.1.1.1/32, or a subnet like 192.168.178.0/24, or domains like example.com and *.example.com)
     */
    address: pulumi.Input<string>;
    /**
     * NetworkResource Description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * NetworkResource status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Group IDs containing the resource
     */
    groups: pulumi.Input<pulumi.Input<string>[]>;
    /**
     * NetworkResource Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * The unique identifier of a network
     */
    networkId: pulumi.Input<string>;
}
//# sourceMappingURL=networkResource.d.ts.map