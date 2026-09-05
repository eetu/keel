import * as pulumi from "@pulumi/pulumi";
export declare class IdentityProvider extends pulumi.CustomResource {
    /**
     * Get an existing IdentityProvider resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: IdentityProviderState, opts?: pulumi.CustomResourceOptions): IdentityProvider;
    /**
     * Returns true if the given object is an instance of IdentityProvider.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is IdentityProvider;
    /**
     * OAuth2 client ID
     */
    readonly clientId: pulumi.Output<string>;
    /**
     * OAuth2 client secret
     */
    readonly clientSecret: pulumi.Output<string>;
    /**
     * OIDC issuer URL
     */
    readonly issuer: pulumi.Output<string>;
    /**
     * Human-readable name for the identity provider
     */
    readonly name: pulumi.Output<string>;
    /**
     * Type of identity provider (entra, google, microsoft, oidc, okta, pocketid, zitadel)
     */
    readonly type: pulumi.Output<string>;
    /**
     * Create a IdentityProvider resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: IdentityProviderArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering IdentityProvider resources.
 */
export interface IdentityProviderState {
    /**
     * OAuth2 client ID
     */
    clientId?: pulumi.Input<string | undefined>;
    /**
     * OAuth2 client secret
     */
    clientSecret?: pulumi.Input<string | undefined>;
    /**
     * OIDC issuer URL
     */
    issuer?: pulumi.Input<string | undefined>;
    /**
     * Human-readable name for the identity provider
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Type of identity provider (entra, google, microsoft, oidc, okta, pocketid, zitadel)
     */
    type?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a IdentityProvider resource.
 */
export interface IdentityProviderArgs {
    /**
     * OAuth2 client ID
     */
    clientId: pulumi.Input<string>;
    /**
     * OAuth2 client secret
     */
    clientSecret: pulumi.Input<string>;
    /**
     * OIDC issuer URL
     */
    issuer: pulumi.Input<string>;
    /**
     * Human-readable name for the identity provider
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Type of identity provider (entra, google, microsoft, oidc, okta, pocketid, zitadel)
     */
    type: pulumi.Input<string>;
}
//# sourceMappingURL=identityProvider.d.ts.map