import * as pulumi from "@pulumi/pulumi";
export declare class Token extends pulumi.CustomResource {
    /**
     * Get an existing Token resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: TokenState, opts?: pulumi.CustomResourceOptions): Token;
    /**
     * Returns true if the given object is an instance of Token.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Token;
    /**
     * Creation timestamp
     */
    readonly createdAt: pulumi.Output<string>;
    /**
     * Token Expiration Date
     */
    readonly expirationDate: pulumi.Output<string>;
    readonly expirationDays: pulumi.Output<number>;
    /**
     * Last usage time
     */
    readonly lastUsed: pulumi.Output<string>;
    /**
     * Token Name
     */
    readonly name: pulumi.Output<string>;
    /**
     * Plaintext token
     */
    readonly token: pulumi.Output<string>;
    /**
     * User ID
     */
    readonly userId: pulumi.Output<string>;
    /**
     * Create a Token resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: TokenArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Token resources.
 */
export interface TokenState {
    /**
     * Creation timestamp
     */
    createdAt?: pulumi.Input<string | undefined>;
    /**
     * Token Expiration Date
     */
    expirationDate?: pulumi.Input<string | undefined>;
    expirationDays?: pulumi.Input<number | undefined>;
    /**
     * Last usage time
     */
    lastUsed?: pulumi.Input<string | undefined>;
    /**
     * Token Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Plaintext token
     */
    token?: pulumi.Input<string | undefined>;
    /**
     * User ID
     */
    userId?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a Token resource.
 */
export interface TokenArgs {
    expirationDays: pulumi.Input<number>;
    /**
     * Token Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * User ID
     */
    userId: pulumi.Input<string>;
}
//# sourceMappingURL=token.d.ts.map