import * as pulumi from "@pulumi/pulumi";
export declare class AccountSettings extends pulumi.CustomResource {
    /**
     * Get an existing AccountSettings resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: AccountSettingsState, opts?: pulumi.CustomResourceOptions): AccountSettings;
    /**
     * Returns true if the given object is an instance of AccountSettings.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is AccountSettings;
    /**
     * Set Clients auto-update version. "latest", "disabled", or a specific version (e.g "0.64.5")
     */
    readonly autoUpdateVersion: pulumi.Output<string>;
    /**
     * Allows to define a custom DNS domain for the account
     */
    readonly dnsDomain: pulumi.Output<string>;
    /**
     * Allows propagate the new user auto groups to peers that belongs to the user
     */
    readonly groupsPropagationEnabled: pulumi.Output<boolean>;
    /**
     * List of groups to which users are allowed access
     */
    readonly jwtAllowGroups: pulumi.Output<string[]>;
    /**
     * Name of the claim from which we extract groups names to add it to account groups.
     */
    readonly jwtGroupsClaimName: pulumi.Output<string>;
    /**
     * Allows extract groups from JWT claim and add it to account groups.
     */
    readonly jwtGroupsEnabled: pulumi.Output<boolean>;
    /**
     * Enables or disables experimental lazy connection
     */
    readonly lazyConnectionEnabled: pulumi.Output<boolean>;
    /**
     * Allows to define a custom network range for the account in CIDR format
     */
    readonly networkRange: pulumi.Output<string>;
    /**
     * Enables or disables network traffic logging. If enabled, all network traffic events from peers will be stored.
     */
    readonly networkTrafficLogsEnabled: pulumi.Output<boolean>;
    /**
     * Limits traffic logging to these groups. If unset all peers are enabled.
     */
    readonly networkTrafficLogsGroups: pulumi.Output<string[]>;
    /**
     * Enables or disables network traffic packet counter. If enabled, network packets and their size will be counted and reported. (This can have an slight impact on performance)
     */
    readonly networkTrafficPacketCounterEnabled: pulumi.Output<boolean>;
    /**
     * (Cloud only) Enables or disables peer approval globally. If enabled, all peers added will be in pending state until approved by an admin.
     */
    readonly peerApprovalEnabled: pulumi.Output<boolean>;
    /**
     * Enables or disables peer expose. If enabled, peers can expose local services through the reverse proxy using the CLI.
     */
    readonly peerExposeEnabled: pulumi.Output<boolean>;
    /**
     * Limits which peer groups are allowed to expose services. If empty, all peers are allowed when peer expose is enabled.
     */
    readonly peerExposeGroups: pulumi.Output<string[]>;
    /**
     * Period of time of inactivity after which peer session expires (seconds).
     */
    readonly peerInactivityExpiration: pulumi.Output<number>;
    /**
     * Enables or disables peer inactivity expiration globally. After peer's session has expired the user has to log in (authenticate). Applies only to peers that were added by a user (interactive SSO login).
     */
    readonly peerInactivityExpirationEnabled: pulumi.Output<boolean>;
    /**
     * Period of time after which peer login expires (seconds).
     */
    readonly peerLoginExpiration: pulumi.Output<number>;
    /**
     * Enables or disables peer login expiration globally. After peer's login has expired the user has to log in (authenticate). Applies only to peers that were added by a user (interactive SSO login).
     */
    readonly peerLoginExpirationEnabled: pulumi.Output<boolean>;
    /**
     * Allows blocking regular users from viewing parts of the system.
     */
    readonly regularUsersViewBlocked: pulumi.Output<boolean>;
    /**
     * Enables or disables DNS resolution on the routing peers
     */
    readonly routingPeerDnsResolutionEnabled: pulumi.Output<boolean>;
    /**
     * Enables manual approval for new users joining via domain matching. When enabled, users are blocked with pending approval status until explicitly approved by an admin.
     */
    readonly userApprovalRequired: pulumi.Output<boolean>;
    /**
     * Create a AccountSettings resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: AccountSettingsArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering AccountSettings resources.
 */
export interface AccountSettingsState {
    /**
     * Set Clients auto-update version. "latest", "disabled", or a specific version (e.g "0.64.5")
     */
    autoUpdateVersion?: pulumi.Input<string | undefined>;
    /**
     * Allows to define a custom DNS domain for the account
     */
    dnsDomain?: pulumi.Input<string | undefined>;
    /**
     * Allows propagate the new user auto groups to peers that belongs to the user
     */
    groupsPropagationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * List of groups to which users are allowed access
     */
    jwtAllowGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Name of the claim from which we extract groups names to add it to account groups.
     */
    jwtGroupsClaimName?: pulumi.Input<string | undefined>;
    /**
     * Allows extract groups from JWT claim and add it to account groups.
     */
    jwtGroupsEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Enables or disables experimental lazy connection
     */
    lazyConnectionEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Allows to define a custom network range for the account in CIDR format
     */
    networkRange?: pulumi.Input<string | undefined>;
    /**
     * Enables or disables network traffic logging. If enabled, all network traffic events from peers will be stored.
     */
    networkTrafficLogsEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Limits traffic logging to these groups. If unset all peers are enabled.
     */
    networkTrafficLogsGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Enables or disables network traffic packet counter. If enabled, network packets and their size will be counted and reported. (This can have an slight impact on performance)
     */
    networkTrafficPacketCounterEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * (Cloud only) Enables or disables peer approval globally. If enabled, all peers added will be in pending state until approved by an admin.
     */
    peerApprovalEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Enables or disables peer expose. If enabled, peers can expose local services through the reverse proxy using the CLI.
     */
    peerExposeEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Limits which peer groups are allowed to expose services. If empty, all peers are allowed when peer expose is enabled.
     */
    peerExposeGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Period of time of inactivity after which peer session expires (seconds).
     */
    peerInactivityExpiration?: pulumi.Input<number | undefined>;
    /**
     * Enables or disables peer inactivity expiration globally. After peer's session has expired the user has to log in (authenticate). Applies only to peers that were added by a user (interactive SSO login).
     */
    peerInactivityExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Period of time after which peer login expires (seconds).
     */
    peerLoginExpiration?: pulumi.Input<number | undefined>;
    /**
     * Enables or disables peer login expiration globally. After peer's login has expired the user has to log in (authenticate). Applies only to peers that were added by a user (interactive SSO login).
     */
    peerLoginExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Allows blocking regular users from viewing parts of the system.
     */
    regularUsersViewBlocked?: pulumi.Input<boolean | undefined>;
    /**
     * Enables or disables DNS resolution on the routing peers
     */
    routingPeerDnsResolutionEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Enables manual approval for new users joining via domain matching. When enabled, users are blocked with pending approval status until explicitly approved by an admin.
     */
    userApprovalRequired?: pulumi.Input<boolean | undefined>;
}
/**
 * The set of arguments for constructing a AccountSettings resource.
 */
export interface AccountSettingsArgs {
    /**
     * Set Clients auto-update version. "latest", "disabled", or a specific version (e.g "0.64.5")
     */
    autoUpdateVersion?: pulumi.Input<string | undefined>;
    /**
     * Allows to define a custom DNS domain for the account
     */
    dnsDomain?: pulumi.Input<string | undefined>;
    /**
     * Allows propagate the new user auto groups to peers that belongs to the user
     */
    groupsPropagationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * List of groups to which users are allowed access
     */
    jwtAllowGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Name of the claim from which we extract groups names to add it to account groups.
     */
    jwtGroupsClaimName?: pulumi.Input<string | undefined>;
    /**
     * Allows extract groups from JWT claim and add it to account groups.
     */
    jwtGroupsEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Enables or disables experimental lazy connection
     */
    lazyConnectionEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Allows to define a custom network range for the account in CIDR format
     */
    networkRange?: pulumi.Input<string | undefined>;
    /**
     * Enables or disables network traffic logging. If enabled, all network traffic events from peers will be stored.
     */
    networkTrafficLogsEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Limits traffic logging to these groups. If unset all peers are enabled.
     */
    networkTrafficLogsGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Enables or disables network traffic packet counter. If enabled, network packets and their size will be counted and reported. (This can have an slight impact on performance)
     */
    networkTrafficPacketCounterEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * (Cloud only) Enables or disables peer approval globally. If enabled, all peers added will be in pending state until approved by an admin.
     */
    peerApprovalEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Enables or disables peer expose. If enabled, peers can expose local services through the reverse proxy using the CLI.
     */
    peerExposeEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Limits which peer groups are allowed to expose services. If empty, all peers are allowed when peer expose is enabled.
     */
    peerExposeGroups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Period of time of inactivity after which peer session expires (seconds).
     */
    peerInactivityExpiration?: pulumi.Input<number | undefined>;
    /**
     * Enables or disables peer inactivity expiration globally. After peer's session has expired the user has to log in (authenticate). Applies only to peers that were added by a user (interactive SSO login).
     */
    peerInactivityExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Period of time after which peer login expires (seconds).
     */
    peerLoginExpiration?: pulumi.Input<number | undefined>;
    /**
     * Enables or disables peer login expiration globally. After peer's login has expired the user has to log in (authenticate). Applies only to peers that were added by a user (interactive SSO login).
     */
    peerLoginExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Allows blocking regular users from viewing parts of the system.
     */
    regularUsersViewBlocked?: pulumi.Input<boolean | undefined>;
    /**
     * Enables or disables DNS resolution on the routing peers
     */
    routingPeerDnsResolutionEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Enables manual approval for new users joining via domain matching. When enabled, users are blocked with pending approval status until explicitly approved by an admin.
     */
    userApprovalRequired?: pulumi.Input<boolean | undefined>;
}
//# sourceMappingURL=accountSettings.d.ts.map