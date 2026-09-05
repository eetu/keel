import * as pulumi from "@pulumi/pulumi";
export declare class Route extends pulumi.CustomResource {
    /**
     * Get an existing Route resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: RouteState, opts?: pulumi.CustomResourceOptions): Route;
    /**
     * Returns true if the given object is an instance of Route.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Route;
    /**
     * Access control group identifier associated with route.
     */
    readonly accessControlGroups: pulumi.Output<string[] | undefined>;
    /**
     * Route description
     */
    readonly description: pulumi.Output<string>;
    /**
     * Domain list to be dynamically resolved. Max of 32 domains can be added per route configuration. Conflicts with network
     */
    readonly domains: pulumi.Output<string[] | undefined>;
    /**
     * Route status
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Group IDs containing routing peers
     */
    readonly groups: pulumi.Output<string[]>;
    /**
     * Indicate if the route should be kept after a domain doesn't resolve that IP anymore
     */
    readonly keepRoute: pulumi.Output<boolean>;
    /**
     * Indicate if peer should masquerade traffic to this route's prefix
     */
    readonly masquerade: pulumi.Output<boolean>;
    /**
     * Route metric number. Lowest number has higher priority
     */
    readonly metric: pulumi.Output<number>;
    /**
     * Network range in CIDR format, Conflicts with domains
     */
    readonly network: pulumi.Output<string | undefined>;
    /**
     * Route network identifier, to group HA routes
     */
    readonly networkId: pulumi.Output<string>;
    /**
     * Domain or IPv4
     */
    readonly networkType: pulumi.Output<string>;
    /**
     * Peer Identifier associated with route. This property can not be set together with peer_groups
     */
    readonly peer: pulumi.Output<string | undefined>;
    /**
     * Peers Group Identifier associated with route. This property can not be set together with peer
     */
    readonly peerGroups: pulumi.Output<string[] | undefined>;
    /**
     * Indicate if this exit node route (0.0.0.0/0) should skip auto-application for client routing
     */
    readonly skipAutoApply: pulumi.Output<boolean>;
    /**
     * Create a Route resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: RouteArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Route resources.
 */
export interface RouteState {
    /**
     * Access control group identifier associated with route.
     */
    accessControlGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Route description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Domain list to be dynamically resolved. Max of 32 domains can be added per route configuration. Conflicts with network
     */
    domains?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Route status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Group IDs containing routing peers
     */
    groups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Indicate if the route should be kept after a domain doesn't resolve that IP anymore
     */
    keepRoute?: pulumi.Input<boolean | undefined>;
    /**
     * Indicate if peer should masquerade traffic to this route's prefix
     */
    masquerade?: pulumi.Input<boolean | undefined>;
    /**
     * Route metric number. Lowest number has higher priority
     */
    metric?: pulumi.Input<number | undefined>;
    /**
     * Network range in CIDR format, Conflicts with domains
     */
    network?: pulumi.Input<string | undefined>;
    /**
     * Route network identifier, to group HA routes
     */
    networkId?: pulumi.Input<string | undefined>;
    /**
     * Domain or IPv4
     */
    networkType?: pulumi.Input<string | undefined>;
    /**
     * Peer Identifier associated with route. This property can not be set together with peer_groups
     */
    peer?: pulumi.Input<string | undefined>;
    /**
     * Peers Group Identifier associated with route. This property can not be set together with peer
     */
    peerGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Indicate if this exit node route (0.0.0.0/0) should skip auto-application for client routing
     */
    skipAutoApply?: pulumi.Input<boolean | undefined>;
}
/**
 * The set of arguments for constructing a Route resource.
 */
export interface RouteArgs {
    /**
     * Access control group identifier associated with route.
     */
    accessControlGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Route description
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Domain list to be dynamically resolved. Max of 32 domains can be added per route configuration. Conflicts with network
     */
    domains?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Route status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Group IDs containing routing peers
     */
    groups: pulumi.Input<pulumi.Input<string>[]>;
    /**
     * Indicate if the route should be kept after a domain doesn't resolve that IP anymore
     */
    keepRoute?: pulumi.Input<boolean | undefined>;
    /**
     * Indicate if peer should masquerade traffic to this route's prefix
     */
    masquerade?: pulumi.Input<boolean | undefined>;
    /**
     * Route metric number. Lowest number has higher priority
     */
    metric?: pulumi.Input<number | undefined>;
    /**
     * Network range in CIDR format, Conflicts with domains
     */
    network?: pulumi.Input<string | undefined>;
    /**
     * Route network identifier, to group HA routes
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
    /**
     * Indicate if this exit node route (0.0.0.0/0) should skip auto-application for client routing
     */
    skipAutoApply?: pulumi.Input<boolean | undefined>;
}
//# sourceMappingURL=route.d.ts.map