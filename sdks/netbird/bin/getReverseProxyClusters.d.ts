import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getReverseProxyClusters(opts?: pulumi.InvokeOptions): Promise<GetReverseProxyClustersResult>;
/**
 * A collection of values returned by getReverseProxyClusters.
 */
export interface GetReverseProxyClustersResult {
    readonly clusters: outputs.GetReverseProxyClustersCluster[];
}
export declare function getReverseProxyClustersOutput(opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetReverseProxyClustersResult>;
//# sourceMappingURL=getReverseProxyClusters.d.ts.map