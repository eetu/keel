import * as pulumi from "@pulumi/pulumi";
export declare function getAccountSettings(opts?: pulumi.InvokeOptions): Promise<GetAccountSettingsResult>;
/**
 * A collection of values returned by getAccountSettings.
 */
export interface GetAccountSettingsResult {
    readonly autoUpdateVersion: string;
    readonly dnsDomain: string;
    readonly groupsPropagationEnabled: boolean;
    readonly id: string;
    readonly jwtAllowGroups: string[];
    readonly jwtGroupsClaimName: string;
    readonly jwtGroupsEnabled: boolean;
    readonly lazyConnectionEnabled: boolean;
    readonly networkRange: string;
    readonly networkTrafficLogsEnabled: boolean;
    readonly networkTrafficLogsGroups: string[];
    readonly networkTrafficPacketCounterEnabled: boolean;
    readonly peerApprovalEnabled: boolean;
    readonly peerExposeEnabled: boolean;
    readonly peerExposeGroups: string[];
    readonly peerInactivityExpiration: number;
    readonly peerInactivityExpirationEnabled: boolean;
    readonly peerLoginExpiration: number;
    readonly peerLoginExpirationEnabled: boolean;
    readonly regularUsersViewBlocked: boolean;
    readonly routingPeerDnsResolutionEnabled: boolean;
    readonly userApprovalRequired: boolean;
}
export declare function getAccountSettingsOutput(opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetAccountSettingsResult>;
//# sourceMappingURL=getAccountSettings.d.ts.map