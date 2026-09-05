import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getReverseProxyService(args?: GetReverseProxyServiceArgs, opts?: pulumi.InvokeOptions): Promise<GetReverseProxyServiceResult>;
/**
 * A collection of arguments for invoking getReverseProxyService.
 */
export interface GetReverseProxyServiceArgs {
    domain?: string;
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getReverseProxyService.
 */
export interface GetReverseProxyServiceResult {
    readonly accessRestrictions: outputs.GetReverseProxyServiceAccessRestrictions;
    readonly auth: outputs.GetReverseProxyServiceAuth;
    readonly domain: string;
    readonly enabled: boolean;
    readonly id: string;
    readonly listenPort: number;
    readonly mode: string;
    readonly name: string;
    readonly passHostHeader: boolean;
    readonly portAutoAssigned: boolean;
    readonly proxyCluster: string;
    readonly rewriteRedirects: boolean;
    readonly targets: outputs.GetReverseProxyServiceTarget[];
}
export declare function getReverseProxyServiceOutput(args?: GetReverseProxyServiceOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetReverseProxyServiceResult>;
/**
 * A collection of arguments for invoking getReverseProxyService.
 */
export interface GetReverseProxyServiceOutputArgs {
    domain?: pulumi.Input<string | undefined>;
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getReverseProxyService.d.ts.map