import * as pulumi from "@pulumi/pulumi";
export declare class DnsZone extends pulumi.CustomResource {
    /**
     * Get an existing DnsZone resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: DnsZoneState, opts?: pulumi.CustomResourceOptions): DnsZone;
    /**
     * Returns true if the given object is an instance of DnsZone.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is DnsZone;
    /**
     * Group IDs that define groups of peers that will resolve this zone
     */
    readonly distributionGroups: pulumi.Output<string[]>;
    /**
     * Zone domain (FQDN)
     */
    readonly domain: pulumi.Output<string>;
    /**
     * Enable this zone as a search domain
     */
    readonly enableSearchDomain: pulumi.Output<boolean>;
    /**
     * DNS Zone status
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * DNS Zone name identifier
     */
    readonly name: pulumi.Output<string>;
    /**
     * Create a DnsZone resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: DnsZoneArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering DnsZone resources.
 */
export interface DnsZoneState {
    /**
     * Group IDs that define groups of peers that will resolve this zone
     */
    distributionGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Zone domain (FQDN)
     */
    domain?: pulumi.Input<string | undefined>;
    /**
     * Enable this zone as a search domain
     */
    enableSearchDomain?: pulumi.Input<boolean | undefined>;
    /**
     * DNS Zone status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * DNS Zone name identifier
     */
    name?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a DnsZone resource.
 */
export interface DnsZoneArgs {
    /**
     * Group IDs that define groups of peers that will resolve this zone
     */
    distributionGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Zone domain (FQDN)
     */
    domain: pulumi.Input<string>;
    /**
     * Enable this zone as a search domain
     */
    enableSearchDomain?: pulumi.Input<boolean | undefined>;
    /**
     * DNS Zone status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * DNS Zone name identifier
     */
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=dnsZone.d.ts.map