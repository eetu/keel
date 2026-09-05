import * as pulumi from "@pulumi/pulumi";
export declare class Scim extends pulumi.CustomResource {
    /**
     * Get an existing Scim resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: ScimState, opts?: pulumi.CustomResourceOptions): Scim;
    /**
     * Returns true if the given object is an instance of Scim.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Scim;
    /**
     * SCIM API token (only available in full after creation)
     */
    readonly authToken: pulumi.Output<string>;
    /**
     * Indicates whether the integration is enabled
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * List of<span pulumi-lang-nodejs=" startWith " pulumi-lang-dotnet=" StartWith " pulumi-lang-go=" startWith " pulumi-lang-python=" start_with " pulumi-lang-yaml=" startWith " pulumi-lang-java=" startWith " pulumi-lang-hcl=" start_with "> startWith </span>string patterns for groups to sync
     */
    readonly groupPrefixes: pulumi.Output<string[]>;
    /**
     * Timestamp of when the integration was last synced
     */
    readonly lastSyncedAt: pulumi.Output<string>;
    /**
     * The connection prefix used for the SCIM provider.
     */
    readonly prefix: pulumi.Output<string>;
    /**
     * Name of the SCIM identity provider
     */
    readonly providerName: pulumi.Output<string>;
    /**
     * List of<span pulumi-lang-nodejs=" startWith " pulumi-lang-dotnet=" StartWith " pulumi-lang-go=" startWith " pulumi-lang-python=" start_with " pulumi-lang-yaml=" startWith " pulumi-lang-java=" startWith " pulumi-lang-hcl=" start_with "> startWith </span>string patterns for groups which users to sync
     */
    readonly userGroupPrefixes: pulumi.Output<string[]>;
    /**
     * Create a Scim resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: ScimArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Scim resources.
 */
export interface ScimState {
    /**
     * SCIM API token (only available in full after creation)
     */
    authToken?: pulumi.Input<string | undefined>;
    /**
     * Indicates whether the integration is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * List of<span pulumi-lang-nodejs=" startWith " pulumi-lang-dotnet=" StartWith " pulumi-lang-go=" startWith " pulumi-lang-python=" start_with " pulumi-lang-yaml=" startWith " pulumi-lang-java=" startWith " pulumi-lang-hcl=" start_with "> startWith </span>string patterns for groups to sync
     */
    groupPrefixes?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Timestamp of when the integration was last synced
     */
    lastSyncedAt?: pulumi.Input<string | undefined>;
    /**
     * The connection prefix used for the SCIM provider.
     */
    prefix?: pulumi.Input<string | undefined>;
    /**
     * Name of the SCIM identity provider
     */
    providerName?: pulumi.Input<string | undefined>;
    /**
     * List of<span pulumi-lang-nodejs=" startWith " pulumi-lang-dotnet=" StartWith " pulumi-lang-go=" startWith " pulumi-lang-python=" start_with " pulumi-lang-yaml=" startWith " pulumi-lang-java=" startWith " pulumi-lang-hcl=" start_with "> startWith </span>string patterns for groups which users to sync
     */
    userGroupPrefixes?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
/**
 * The set of arguments for constructing a Scim resource.
 */
export interface ScimArgs {
    /**
     * Indicates whether the integration is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * List of<span pulumi-lang-nodejs=" startWith " pulumi-lang-dotnet=" StartWith " pulumi-lang-go=" startWith " pulumi-lang-python=" start_with " pulumi-lang-yaml=" startWith " pulumi-lang-java=" startWith " pulumi-lang-hcl=" start_with "> startWith </span>string patterns for groups to sync
     */
    groupPrefixes?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * The connection prefix used for the SCIM provider.
     */
    prefix?: pulumi.Input<string | undefined>;
    /**
     * Name of the SCIM identity provider
     */
    providerName: pulumi.Input<string>;
    /**
     * List of<span pulumi-lang-nodejs=" startWith " pulumi-lang-dotnet=" StartWith " pulumi-lang-go=" startWith " pulumi-lang-python=" start_with " pulumi-lang-yaml=" startWith " pulumi-lang-java=" startWith " pulumi-lang-hcl=" start_with "> startWith </span>string patterns for groups which users to sync
     */
    userGroupPrefixes?: pulumi.Input<pulumi.Input<string>[] | undefined>;
}
//# sourceMappingURL=scim.d.ts.map