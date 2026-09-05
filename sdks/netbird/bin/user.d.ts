import * as pulumi from "@pulumi/pulumi";
export declare class User extends pulumi.CustomResource {
    /**
     * Get an existing User resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: UserState, opts?: pulumi.CustomResourceOptions): User;
    /**
     * Returns true if the given object is an instance of User.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is User;
    /**
     * Group IDs to auto-assign to peers registered by this user
     */
    readonly autoGroups: pulumi.Output<string[]>;
    /**
     * User Email
     */
    readonly email: pulumi.Output<string>;
    /**
     * If set to true then user is blocked and can't use the system
     */
    readonly isBlocked: pulumi.Output<boolean>;
    /**
     * Set to true if the caller user is the same as the resource user
     */
    readonly isCurrent: pulumi.Output<boolean>;
    /**
     * If set to true, creates a Service Account User
     */
    readonly isServiceUser: pulumi.Output<boolean>;
    /**
     * User issue method
     */
    readonly issued: pulumi.Output<string>;
    /**
     * User Last Login timedate
     */
    readonly lastLogin: pulumi.Output<string>;
    /**
     * User Name
     */
    readonly name: pulumi.Output<string>;
    /**
     * User's NetBird account role (owner|admin|user|billing_admin|auditor|network_admin).
     */
    readonly role: pulumi.Output<string>;
    /**
     * User status (active, invited or blocked)
     */
    readonly status: pulumi.Output<string>;
    /**
     * Create a User resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: UserArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering User resources.
 */
export interface UserState {
    /**
     * Group IDs to auto-assign to peers registered by this user
     */
    autoGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * User Email
     */
    email?: pulumi.Input<string | undefined>;
    /**
     * If set to true then user is blocked and can't use the system
     */
    isBlocked?: pulumi.Input<boolean | undefined>;
    /**
     * Set to true if the caller user is the same as the resource user
     */
    isCurrent?: pulumi.Input<boolean | undefined>;
    /**
     * If set to true, creates a Service Account User
     */
    isServiceUser?: pulumi.Input<boolean | undefined>;
    /**
     * User issue method
     */
    issued?: pulumi.Input<string | undefined>;
    /**
     * User Last Login timedate
     */
    lastLogin?: pulumi.Input<string | undefined>;
    /**
     * User Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * User's NetBird account role (owner|admin|user|billing_admin|auditor|network_admin).
     */
    role?: pulumi.Input<string | undefined>;
    /**
     * User status (active, invited or blocked)
     */
    status?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a User resource.
 */
export interface UserArgs {
    /**
     * Group IDs to auto-assign to peers registered by this user
     */
    autoGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * User Email
     */
    email?: pulumi.Input<string | undefined>;
    /**
     * If set to true then user is blocked and can't use the system
     */
    isBlocked?: pulumi.Input<boolean | undefined>;
    /**
     * If set to true, creates a Service Account User
     */
    isServiceUser: pulumi.Input<boolean>;
    /**
     * User Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * User's NetBird account role (owner|admin|user|billing_admin|auditor|network_admin).
     */
    role?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=user.d.ts.map