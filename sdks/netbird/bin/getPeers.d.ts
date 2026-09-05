import * as pulumi from "@pulumi/pulumi";
export declare function getPeers(args?: GetPeersArgs, opts?: pulumi.InvokeOptions): Promise<GetPeersResult>;
/**
 * A collection of arguments for invoking getPeers.
 */
export interface GetPeersArgs {
    approvalRequired?: boolean;
    cityName?: string;
    connected?: boolean;
    connectionIp?: string;
    countryCode?: string;
    dnsLabel?: string;
    extraDnsLabels?: string[];
    geonameId?: number;
    groups?: string[];
    hostname?: string;
    inactivityExpirationEnabled?: boolean;
    ip?: string;
    loginExpirationEnabled?: boolean;
    loginExpired?: boolean;
    name?: string;
    os?: string;
    sshEnabled?: boolean;
    userId?: string;
}
/**
 * A collection of values returned by getPeers.
 */
export interface GetPeersResult {
    readonly approvalRequired: boolean;
    readonly cityName: string;
    readonly connected: boolean;
    readonly connectionIp: string;
    readonly countryCode: string;
    readonly dnsLabel: string;
    readonly extraDnsLabels: string[];
    readonly geonameId: number;
    readonly groups: string[];
    readonly hostname: string;
    readonly ids: string[];
    readonly inactivityExpirationEnabled: boolean;
    readonly ip: string;
    readonly kernelVersion: string;
    readonly lastLogin: string;
    readonly lastSeen: string;
    readonly loginExpirationEnabled: boolean;
    readonly loginExpired: boolean;
    readonly name: string;
    readonly os: string;
    readonly serialNumber: string;
    readonly sshEnabled: boolean;
    readonly uiVersion: string;
    readonly userId: string;
    readonly version: string;
}
export declare function getPeersOutput(args?: GetPeersOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetPeersResult>;
/**
 * A collection of arguments for invoking getPeers.
 */
export interface GetPeersOutputArgs {
    approvalRequired?: pulumi.Input<boolean | undefined>;
    cityName?: pulumi.Input<string | undefined>;
    connected?: pulumi.Input<boolean | undefined>;
    connectionIp?: pulumi.Input<string | undefined>;
    countryCode?: pulumi.Input<string | undefined>;
    dnsLabel?: pulumi.Input<string | undefined>;
    extraDnsLabels?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    geonameId?: pulumi.Input<number | undefined>;
    groups?: pulumi.Input<pulumi.Input<string>[] | undefined>;
    hostname?: pulumi.Input<string | undefined>;
    inactivityExpirationEnabled?: pulumi.Input<boolean | undefined>;
    ip?: pulumi.Input<string | undefined>;
    loginExpirationEnabled?: pulumi.Input<boolean | undefined>;
    loginExpired?: pulumi.Input<boolean | undefined>;
    name?: pulumi.Input<string | undefined>;
    os?: pulumi.Input<string | undefined>;
    sshEnabled?: pulumi.Input<boolean | undefined>;
    userId?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getPeers.d.ts.map