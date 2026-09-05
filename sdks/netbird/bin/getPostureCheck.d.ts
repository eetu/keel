import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getPostureCheck(args?: GetPostureCheckArgs, opts?: pulumi.InvokeOptions): Promise<GetPostureCheckResult>;
/**
 * A collection of arguments for invoking getPostureCheck.
 */
export interface GetPostureCheckArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getPostureCheck.
 */
export interface GetPostureCheckResult {
    readonly description: string;
    readonly geoLocationCheck: outputs.GetPostureCheckGeoLocationCheck;
    readonly id: string;
    readonly name: string;
    readonly netbirdVersionCheck: outputs.GetPostureCheckNetbirdVersionCheck;
    readonly osVersionCheck: outputs.GetPostureCheckOsVersionCheck;
    readonly peerNetworkRangeCheck: outputs.GetPostureCheckPeerNetworkRangeCheck;
    readonly processChecks: outputs.GetPostureCheckProcessCheck[];
}
export declare function getPostureCheckOutput(args?: GetPostureCheckOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetPostureCheckResult>;
/**
 * A collection of arguments for invoking getPostureCheck.
 */
export interface GetPostureCheckOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getPostureCheck.d.ts.map