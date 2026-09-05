import * as pulumi from "@pulumi/pulumi";
export declare function getDnsRecord(args: GetDnsRecordArgs, opts?: pulumi.InvokeOptions): Promise<GetDnsRecordResult>;
/**
 * A collection of arguments for invoking getDnsRecord.
 */
export interface GetDnsRecordArgs {
    id?: string;
    name?: string;
    type?: string;
    zoneId: string;
}
/**
 * A collection of values returned by getDnsRecord.
 */
export interface GetDnsRecordResult {
    readonly content: string;
    readonly id: string;
    readonly name: string;
    readonly ttl: number;
    readonly type: string;
    readonly zoneId: string;
}
export declare function getDnsRecordOutput(args: GetDnsRecordOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetDnsRecordResult>;
/**
 * A collection of arguments for invoking getDnsRecord.
 */
export interface GetDnsRecordOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
    type?: pulumi.Input<string | undefined>;
    zoneId: pulumi.Input<string>;
}
//# sourceMappingURL=getDnsRecord.d.ts.map