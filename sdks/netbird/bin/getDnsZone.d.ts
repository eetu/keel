import * as pulumi from "@pulumi/pulumi";
export declare function getDnsZone(args?: GetDnsZoneArgs, opts?: pulumi.InvokeOptions): Promise<GetDnsZoneResult>;
/**
 * A collection of arguments for invoking getDnsZone.
 */
export interface GetDnsZoneArgs {
    domain?: string;
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getDnsZone.
 */
export interface GetDnsZoneResult {
    readonly distributionGroups: string[];
    readonly domain: string;
    readonly enableSearchDomain: boolean;
    readonly enabled: boolean;
    readonly id: string;
    readonly name: string;
}
export declare function getDnsZoneOutput(args?: GetDnsZoneOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetDnsZoneResult>;
/**
 * A collection of arguments for invoking getDnsZone.
 */
export interface GetDnsZoneOutputArgs {
    domain?: pulumi.Input<string | undefined>;
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getDnsZone.d.ts.map