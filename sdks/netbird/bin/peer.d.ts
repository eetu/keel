import * as pulumi from "@pulumi/pulumi";
export declare class Peer extends pulumi.CustomResource {
    /**
     * Get an existing Peer resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: PeerState, opts?: pulumi.CustomResourceOptions): Peer;
    /**
     * Returns true if the given object is an instance of Peer.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is Peer;
    /**
     * Indicates whether peer needs approval
     */
    readonly approvalRequired: pulumi.Output<boolean>;
    /**
     * Peer city name
     */
    readonly cityName: pulumi.Output<string>;
    /**
     * Peer Connection Status
     */
    readonly connected: pulumi.Output<boolean>;
    /**
     * Peer Public IP
     */
    readonly connectionIp: pulumi.Output<string>;
    /**
     * Peer country code
     */
    readonly countryCode: pulumi.Output<string>;
    /**
     * Peer DNS Label
     */
    readonly dnsLabel: pulumi.Output<string>;
    /**
     * Peer extra DNS Labels
     */
    readonly extraDnsLabels: pulumi.Output<string[]>;
    /**
     * Peer Location ID
     */
    readonly geonameId: pulumi.Output<number>;
    /**
     * Peer groups
     */
    readonly groups: pulumi.Output<string[]>;
    /**
     * Peer's HOSTNAME
     */
    readonly hostname: pulumi.Output<string>;
    /**
     * Enable inactivity expiration for peer
     */
    readonly inactivityExpirationEnabled: pulumi.Output<boolean>;
    /**
     * Peer  IP
     */
    readonly ip: pulumi.Output<string>;
    /**
     * Peer Kernel Version
     */
    readonly kernelVersion: pulumi.Output<string>;
    /**
     * Time of peer last login
     */
    readonly lastLogin: pulumi.Output<string>;
    /**
     * Peer Last Seen timedate
     */
    readonly lastSeen: pulumi.Output<string>;
    /**
     * Indicates whether login expiration is enabled for peer
     */
    readonly loginExpirationEnabled: pulumi.Output<boolean>;
    /**
     * Indicates whether peer login is expired
     */
    readonly loginExpired: pulumi.Output<boolean>;
    /**
     * Peer Name
     */
    readonly name: pulumi.Output<string>;
    /**
     * Peer OS
     */
    readonly os: pulumi.Output<string>;
    /**
     * Peer ID
     */
    readonly peerId: pulumi.Output<string>;
    /**
     * Peer device serial number
     */
    readonly serialNumber: pulumi.Output<string>;
    /**
     * Enable SSH to Peer
     */
    readonly sshEnabled: pulumi.Output<boolean>;
    /**
     * Peer  UI Version
     */
    readonly uiVersion: pulumi.Output<string>;
    /**
     * User ID of peer
     */
    readonly userId: pulumi.Output<string>;
    /**
     * Peer  Version
     */
    readonly version: pulumi.Output<string>;
    /**
     * Create a Peer resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: PeerArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering Peer resources.
 */
export interface PeerState {
    /**
     * Indicates whether peer needs approval
     */
    approvalRequired?: pulumi.Input<boolean | undefined>;
    /**
     * Peer city name
     */
    cityName?: pulumi.Input<string | undefined>;
    /**
     * Peer Connection Status
     */
    connected?: pulumi.Input<boolean | undefined>;
    /**
     * Peer Public IP
     */
    connectionIp?: pulumi.Input<string | undefined>;
    /**
     * Peer country code
     */
    countryCode?: pulumi.Input<string | undefined>;
    /**
     * Peer DNS Label
     */
    dnsLabel?: pulumi.Input<string | undefined>;
    /**
     * Peer extra DNS Labels
     */
    extraDnsLabels?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Peer Location ID
     */
    geonameId?: pulumi.Input<number | undefined>;
    /**
     * Peer groups
     */
    groups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    /**
     * Peer's HOSTNAME
     */
    hostname?: pulumi.Input<string | undefined>;
    /**
     * Enable inactivity expiration for peer
     */
    inactivityExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Peer  IP
     */
    ip?: pulumi.Input<string | undefined>;
    /**
     * Peer Kernel Version
     */
    kernelVersion?: pulumi.Input<string | undefined>;
    /**
     * Time of peer last login
     */
    lastLogin?: pulumi.Input<string | undefined>;
    /**
     * Peer Last Seen timedate
     */
    lastSeen?: pulumi.Input<string | undefined>;
    /**
     * Indicates whether login expiration is enabled for peer
     */
    loginExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Indicates whether peer login is expired
     */
    loginExpired?: pulumi.Input<boolean | undefined>;
    /**
     * Peer Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Peer OS
     */
    os?: pulumi.Input<string | undefined>;
    /**
     * Peer ID
     */
    peerId?: pulumi.Input<string | undefined>;
    /**
     * Peer device serial number
     */
    serialNumber?: pulumi.Input<string | undefined>;
    /**
     * Enable SSH to Peer
     */
    sshEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Peer  UI Version
     */
    uiVersion?: pulumi.Input<string | undefined>;
    /**
     * User ID of peer
     */
    userId?: pulumi.Input<string | undefined>;
    /**
     * Peer  Version
     */
    version?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a Peer resource.
 */
export interface PeerArgs {
    /**
     * Indicates whether peer needs approval
     */
    approvalRequired?: pulumi.Input<boolean | undefined>;
    /**
     * Enable inactivity expiration for peer
     */
    inactivityExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Indicates whether login expiration is enabled for peer
     */
    loginExpirationEnabled?: pulumi.Input<boolean | undefined>;
    /**
     * Peer Name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Peer ID
     */
    peerId: pulumi.Input<string>;
    /**
     * Enable SSH to Peer
     */
    sshEnabled?: pulumi.Input<boolean | undefined>;
}
//# sourceMappingURL=peer.d.ts.map