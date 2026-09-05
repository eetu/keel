import * as pulumi from "@pulumi/pulumi";
export declare class ReverseProxyDomain extends pulumi.CustomResource {
    /**
     * Get an existing ReverseProxyDomain resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: ReverseProxyDomainState, opts?: pulumi.CustomResourceOptions): ReverseProxyDomain;
    /**
     * Returns true if the given object is an instance of ReverseProxyDomain.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is ReverseProxyDomain;
    /**
     * Domain name
     */
    readonly domain: pulumi.Output<string>;
    /**
     * The proxy cluster this domain should be validated against
     */
    readonly targetCluster: pulumi.Output<string>;
    /**
     * Type of reverse proxy domain (free, custom)
     */
    readonly type: pulumi.Output<string>;
    /**
     * Whether the domain has been validated
     */
    readonly validated: pulumi.Output<boolean>;
    /**
     * Create a ReverseProxyDomain resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: ReverseProxyDomainArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering ReverseProxyDomain resources.
 */
export interface ReverseProxyDomainState {
    /**
     * Domain name
     */
    domain?: pulumi.Input<string | undefined>;
    /**
     * The proxy cluster this domain should be validated against
     */
    targetCluster?: pulumi.Input<string | undefined>;
    /**
     * Type of reverse proxy domain (free, custom)
     */
    type?: pulumi.Input<string | undefined>;
    /**
     * Whether the domain has been validated
     */
    validated?: pulumi.Input<boolean | undefined>;
}
/**
 * The set of arguments for constructing a ReverseProxyDomain resource.
 */
export interface ReverseProxyDomainArgs {
    /**
     * Domain name
     */
    domain: pulumi.Input<string>;
    /**
     * The proxy cluster this domain should be validated against
     */
    targetCluster: pulumi.Input<string>;
}
//# sourceMappingURL=reverseProxyDomain.d.ts.map