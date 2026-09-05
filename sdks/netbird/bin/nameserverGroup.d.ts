import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class NameserverGroup extends pulumi.CustomResource {
    /**
     * Get an existing NameserverGroup resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: NameserverGroupState, opts?: pulumi.CustomResourceOptions): NameserverGroup;
    /**
     * Returns true if the given object is an instance of NameserverGroup.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is NameserverGroup;
    /**
     * Description of the nameserver group
     */
    readonly description: pulumi.Output<string>;
    /**
     * Match domain list. It should be empty only if primary is true.
     */
    readonly domains: pulumi.Output<string[]>;
    /**
     * Nameserver group status
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Distribution group IDs that defines group of peers that will use this nameserver group
     */
    readonly groups: pulumi.Output<string[]>;
    /**
     * Name of nameserver group
     */
    readonly name: pulumi.Output<string>;
    /**
     * Nameserver list
     */
    readonly nameservers: pulumi.Output<outputs.NameserverGroupNameserver[]>;
    /**
     * Defines if a nameserver group is primary that resolves all domains. It should be true only if domains list is empty.
     */
    readonly primary: pulumi.Output<boolean>;
    /**
     * Search domain status for match domains. It should be true only if domains list is not empty.
     */
    readonly searchDomainsEnabled: pulumi.Output<boolean>;
    /**
     * Create a NameserverGroup resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: NameserverGroupArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering NameserverGroup resources.
 */
export interface NameserverGroupState {
    /**
     * Description of the nameserver group
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Match domain list. It should be empty only if primary is true.
     */
    domains?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Nameserver group status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Distribution group IDs that defines group of peers that will use this nameserver group
     */
    groups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Name of nameserver group
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Nameserver list
     */
    nameservers?: pulumi.Input<pulumi.Input<inputs.NameserverGroupNameserver>[] | undefined>;
    /**
     * Defines if a nameserver group is primary that resolves all domains. It should be true only if domains list is empty.
     */
    primary?: pulumi.Input<boolean | undefined>;
    /**
     * Search domain status for match domains. It should be true only if domains list is not empty.
     */
    searchDomainsEnabled?: pulumi.Input<boolean | undefined>;
}
/**
 * The set of arguments for constructing a NameserverGroup resource.
 */
export interface NameserverGroupArgs {
    /**
     * Description of the nameserver group
     */
    description?: pulumi.Input<string | undefined>;
    /**
     * Match domain list. It should be empty only if primary is true.
     */
    domains?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Nameserver group status
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Distribution group IDs that defines group of peers that will use this nameserver group
     */
    groups: pulumi.Input<pulumi.Input<string>[]>;
    /**
     * Name of nameserver group
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Nameserver list
     */
    nameservers: pulumi.Input<pulumi.Input<inputs.NameserverGroupNameserver>[]>;
    /**
     * Defines if a nameserver group is primary that resolves all domains. It should be true only if domains list is empty.
     */
    primary?: pulumi.Input<boolean | undefined>;
    /**
     * Search domain status for match domains. It should be true only if domains list is not empty.
     */
    searchDomainsEnabled?: pulumi.Input<boolean | undefined>;
}
//# sourceMappingURL=nameserverGroup.d.ts.map