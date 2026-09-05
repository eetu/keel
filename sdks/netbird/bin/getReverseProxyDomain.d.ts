import * as pulumi from "@pulumi/pulumi";
export declare function getReverseProxyDomain(args?: GetReverseProxyDomainArgs, opts?: pulumi.InvokeOptions): Promise<GetReverseProxyDomainResult>;
/**
 * A collection of arguments for invoking getReverseProxyDomain.
 */
export interface GetReverseProxyDomainArgs {
    domain?: string;
    id?: string;
    type?: string;
    validated?: boolean;
}
/**
 * A collection of values returned by getReverseProxyDomain.
 */
export interface GetReverseProxyDomainResult {
    readonly domain: string;
    readonly id: string;
    readonly targetCluster: string;
    readonly type: string;
    readonly validated: boolean;
}
export declare function getReverseProxyDomainOutput(args?: GetReverseProxyDomainOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetReverseProxyDomainResult>;
/**
 * A collection of arguments for invoking getReverseProxyDomain.
 */
export interface GetReverseProxyDomainOutputArgs {
    domain?: pulumi.Input<string | undefined>;
    id?: pulumi.Input<string | undefined>;
    type?: pulumi.Input<string | undefined>;
    validated?: pulumi.Input<boolean | undefined>;
}
//# sourceMappingURL=getReverseProxyDomain.d.ts.map