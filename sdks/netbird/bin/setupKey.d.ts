import * as pulumi from "@pulumi/pulumi";
export declare class SetupKey extends pulumi.CustomResource {
    /**
     * Get an existing SetupKey resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: SetupKeyState, opts?: pulumi.CustomResourceOptions): SetupKey;
    /**
     * Returns true if the given object is an instance of SetupKey.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is SetupKey;
    /**
     * Allow extra DNS labels to be added to the peer
     */
    readonly allowExtraDnsLabels: pulumi.Output<boolean>;
    /**
     * List of groups to automatically assign to peers created through this setup key
     */
    readonly autoGroups: pulumi.Output<string[]>;
    /**
     * Indicate that the peer will be ephemeral or not, ephemeral peers are deleted after 10 minutes of inactivity
     */
    readonly ephemeral: pulumi.Output<boolean>;
    /**
     * SetupKey Expiration Date
     */
    readonly expires: pulumi.Output<string>;
    /**
     * Expiry time in seconds (0 is unlimited). The API reports an absolute expiry date and no creation date, so this value cannot be read back and an imported key adopts whatever the configuration says.
     */
    readonly expirySeconds: pulumi.Output<number>;
    /**
     * Plaintext setup key
     */
    readonly key: pulumi.Output<string>;
    /**
     * Last usage time
     */
    readonly lastUsed: pulumi.Output<string>;
    /**
     * SetupKey Name
     */
    readonly name: pulumi.Output<string>;
    /**
     * Set to true to revoke setup key
     */
    readonly revoked: pulumi.Output<boolean>;
    /**
     * Setup key state (valid or expired)
     */
    readonly state: pulumi.Output<string>;
    /**
     * Setup Key type (one-off or reusable)
     */
    readonly type: pulumi.Output<string>;
    /**
     * Creation timestamp
     */
    readonly updatedAt: pulumi.Output<string>;
    /**
     * Maximum number of times SetupKey can be used (0 for unlimited). A one-off key is always limited to 1 by the server, so leave this unset for one-off keys.
     */
    readonly usageLimit: pulumi.Output<number>;
    /**
     * Number of times Setup Key was used
     */
    readonly usedTimes: pulumi.Output<number>;
    /**
     * True if setup key can be used to create more Peers
     */
    readonly valid: pulumi.Output<boolean>;
    /**
     * Create a SetupKey resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: SetupKeyArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering SetupKey resources.
 */
export interface SetupKeyState {
    /**
     * Allow extra DNS labels to be added to the peer
     */
    allowExtraDnsLabels?: pulumi.Input<boolean | undefined>;
    /**
     * List of groups to automatically assign to peers created through this setup key
     */
    autoGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Indicate that the peer will be ephemeral or not, ephemeral peers are deleted after 10 minutes of inactivity
     */
    ephemeral?: pulumi.Input<boolean | undefined>;
    /**
     * SetupKey Expiration Date
     */
    expires?: pulumi.Input<string | undefined>;
    /**
     * Expiry time in seconds (0 is unlimited). The API reports an absolute expiry date and no creation date, so this value cannot be read back and an imported key adopts whatever the configuration says.
     */
    expirySeconds?: pulumi.Input<number | undefined>;
    /**
     * Plaintext setup key
     */
    key?: pulumi.Input<string | undefined>;
    /**
     * Last usage time
     */
    lastUsed?: pulumi.Input<string | undefined>;
    /**
     * SetupKey Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Set to true to revoke setup key
     */
    revoked?: pulumi.Input<boolean | undefined>;
    /**
     * Setup key state (valid or expired)
     */
    state?: pulumi.Input<string | undefined>;
    /**
     * Setup Key type (one-off or reusable)
     */
    type?: pulumi.Input<string | undefined>;
    /**
     * Creation timestamp
     */
    updatedAt?: pulumi.Input<string | undefined>;
    /**
     * Maximum number of times SetupKey can be used (0 for unlimited). A one-off key is always limited to 1 by the server, so leave this unset for one-off keys.
     */
    usageLimit?: pulumi.Input<number | undefined>;
    /**
     * Number of times Setup Key was used
     */
    usedTimes?: pulumi.Input<number | undefined>;
    /**
     * True if setup key can be used to create more Peers
     */
    valid?: pulumi.Input<boolean | undefined>;
}
/**
 * The set of arguments for constructing a SetupKey resource.
 */
export interface SetupKeyArgs {
    /**
     * Allow extra DNS labels to be added to the peer
     */
    allowExtraDnsLabels?: pulumi.Input<boolean | undefined>;
    /**
     * List of groups to automatically assign to peers created through this setup key
     */
    autoGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Indicate that the peer will be ephemeral or not, ephemeral peers are deleted after 10 minutes of inactivity
     */
    ephemeral?: pulumi.Input<boolean | undefined>;
    /**
     * Expiry time in seconds (0 is unlimited). The API reports an absolute expiry date and no creation date, so this value cannot be read back and an imported key adopts whatever the configuration says.
     */
    expirySeconds?: pulumi.Input<number | undefined>;
    /**
     * SetupKey Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Set to true to revoke setup key
     */
    revoked?: pulumi.Input<boolean | undefined>;
    /**
     * Setup Key type (one-off or reusable)
     */
    type?: pulumi.Input<string | undefined>;
    /**
     * Maximum number of times SetupKey can be used (0 for unlimited). A one-off key is always limited to 1 by the server, so leave this unset for one-off keys.
     */
    usageLimit?: pulumi.Input<number | undefined>;
}
//# sourceMappingURL=setupKey.d.ts.map