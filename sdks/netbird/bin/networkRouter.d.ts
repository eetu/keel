import * as pulumi from "@pulumi/pulumi";
export declare class NetworkRouter extends pulumi.CustomResource {
    /**
     * Get an existing NetworkRouter resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: NetworkRouterState, opts?: pulumi.CustomResourceOptions): NetworkRouter;
    /**
     * Returns true if the given object is an instance of NetworkRouter.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is NetworkRouter;
    /**
     * Network router status
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Indicate if peer should masquerade traffic to this route's prefix
     */
    readonly masquerade: pulumi.Output<boolean>;
    /**
     * Route metric number. Lowest number has higher priority
     */
    readonly metric: pulumi.Output<number>;
    /**
     * The unique identifier of a network
     */
    readonly networkId: pulumi.Output<string>;
    /**
     * Peer Identifier associated with route. This property can not be set together with peer_groups
     */
    readonly peer: pulumi.Output<string | undefined>;
    /**
     * Peers Group Identifier associated with route. This property can not be set together with peer
     */
    readonly peerGroups: pulumi.Output<string[] | undefined>;
    /**
     * Create a NetworkRouter resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: NetworkRouterArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering NetworkRouter resources.
 */
export interface NetworkRouterState {
    /**
     * Network router status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Indicate if peer should masquerade traffic to this route's prefix
     */
    masquerade?: pulumi.Input<boolean | undefined>;
    /**
     * Route metric number. Lowest number has higher priority
     */
    metric?: pulumi.Input<number | undefined>;
    /**
     * The unique identifier of a network
     */
    networkId?: pulumi.Input<string | undefined>;
    /**
     * Peer Identifier associated with route. This property can not be set together with peer_groups
     */
    peer?: pulumi.Input<string | undefined>;
    /**
     * Peers Group Identifier associated with route. This property can not be set together with peer
     */
    peerGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
/**
 * The set of arguments for constructing a NetworkRouter resource.
 */
export interface NetworkRouterArgs {
    /**
     * Network router status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Indicate if peer should masquerade traffic to this route's prefix
     */
    masquerade?: pulumi.Input<boolean | undefined>;
    /**
     * Route metric number. Lowest number has higher priority
     */
    metric?: pulumi.Input<number | undefined>;
    /**
     * The unique identifier of a network
     */
    networkId: pulumi.Input<string>;
    /**
     * Peer Identifier associated with route. This property can not be set together with peer_groups
     */
    peer?: pulumi.Input<string | undefined>;
    /**
     * Peers Group Identifier associated with route. This property can not be set together with peer
     */
    peerGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
//# sourceMappingURL=networkRouter.d.ts.map