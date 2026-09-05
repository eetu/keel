import * as pulumi from "@pulumi/pulumi";
export declare function getPeer(args?: GetPeerArgs, opts?: pulumi.InvokeOptions): Promise<GetPeerResult>;
/**
 * A collection of arguments for invoking getPeer.
 */
export interface GetPeerArgs {
    id?: string;
    ip?: string;
    name?: string;
}
/**
 * A collection of values returned by getPeer.
 */
export interface GetPeerResult {
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
    readonly id: string;
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
export declare function getPeerOutput(args?: GetPeerOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetPeerResult>;
/**
 * A collection of arguments for invoking getPeer.
 */
export interface GetPeerOutputArgs {
    id?: pulumi.Input<string | undefined>;
    ip?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getPeer.d.ts.map