import * as pulumi from "@pulumi/pulumi";
export declare class DnsRecord extends pulumi.CustomResource {
    /**
     * Get an existing DnsRecord resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: DnsRecordState, opts?: pulumi.CustomResourceOptions): DnsRecord;
    /**
     * Returns true if the given object is an instance of DnsRecord.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is DnsRecord;
    /**
     * DNS record content (IP address for A/AAAA, domain for CNAME)
     */
    readonly content: pulumi.Output<string>;
    /**
     * DNS record name as a full FQDN (e.g., 'www.example.com' or 'example.com' for root domain). Short names like 'www' or '@' are not supported
     */
    readonly name: pulumi.Output<string>;
    /**
     * Time to live in seconds
     */
    readonly ttl: pulumi.Output<number>;
    /**
     * DNS record type (A, AAAA, or CNAME)
     */
    readonly type: pulumi.Output<string>;
    /**
     * DNS Zone ID that this record belongs to
     */
    readonly zoneId: pulumi.Output<string>;
    /**
     * Create a DnsRecord resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: DnsRecordArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering DnsRecord resources.
 */
export interface DnsRecordState {
    /**
     * DNS record content (IP address for A/AAAA, domain for CNAME)
     */
    content?: pulumi.Input<string | undefined>;
    /**
     * DNS record name as a full FQDN (e.g., 'www.example.com' or 'example.com' for root domain). Short names like 'www' or '@' are not supported
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Time to live in seconds
     */
    ttl?: pulumi.Input<number | undefined>;
    /**
     * DNS record type (A, AAAA, or CNAME)
     */
    type?: pulumi.Input<string | undefined>;
    /**
     * DNS Zone ID that this record belongs to
     */
    zoneId?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a DnsRecord resource.
 */
export interface DnsRecordArgs {
    /**
     * DNS record content (IP address for A/AAAA, domain for CNAME)
     */
    content: pulumi.Input<string>;
    /**
     * DNS record name as a full FQDN (e.g., 'www.example.com' or 'example.com' for root domain). Short names like 'www' or '@' are not supported
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Time to live in seconds
     */
    ttl?: pulumi.Input<number | undefined>;
    /**
     * DNS record type (A, AAAA, or CNAME)
     */
    type: pulumi.Input<string>;
    /**
     * DNS Zone ID that this record belongs to
     */
    zoneId: pulumi.Input<string>;
}
//# sourceMappingURL=dnsRecord.d.ts.map