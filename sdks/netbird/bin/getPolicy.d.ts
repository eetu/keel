import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare function getPolicy(args?: GetPolicyArgs, opts?: pulumi.InvokeOptions): Promise<GetPolicyResult>;
/**
 * A collection of arguments for invoking getPolicy.
 */
export interface GetPolicyArgs {
    id?: string;
    name?: string;
    rules?: inputs.GetPolicyRule[];
}
/**
 * A collection of values returned by getPolicy.
 */
export interface GetPolicyResult {
    readonly description: string;
    readonly enabled: boolean;
    readonly id: string;
    readonly name: string;
    readonly rules?: outputs.GetPolicyRule[];
    readonly sourcePostureChecks: string[];
}
export declare function getPolicyOutput(args?: GetPolicyOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetPolicyResult>;
/**
 * A collection of arguments for invoking getPolicy.
 */
export interface GetPolicyOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
    rules?: pulumi.Input<pulumi.Input<inputs.GetPolicyRuleArgs>[] | undefined>;
}
//# sourceMappingURL=getPolicy.d.ts.map