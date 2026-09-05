import * as pulumi from "@pulumi/pulumi";
export declare function getDnsSettings(opts?: pulumi.InvokeOptions): Promise<GetDnsSettingsResult>;
/**
 * A collection of values returned by getDnsSettings.
 */
export interface GetDnsSettingsResult {
    readonly disabledManagementGroups: string[];
}
export declare function getDnsSettingsOutput(opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetDnsSettingsResult>;
//# sourceMappingURL=getDnsSettings.d.ts.map