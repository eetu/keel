import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getAgentNetworkGuardrail(args?: GetAgentNetworkGuardrailArgs, opts?: pulumi.InvokeOptions): Promise<GetAgentNetworkGuardrailResult>;
/**
 * A collection of arguments for invoking getAgentNetworkGuardrail.
 */
export interface GetAgentNetworkGuardrailArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getAgentNetworkGuardrail.
 */
export interface GetAgentNetworkGuardrailResult {
    readonly description: string;
    readonly id: string;
    readonly modelAllowlist: outputs.GetAgentNetworkGuardrailModelAllowlist;
    readonly name: string;
    readonly promptCapture: outputs.GetAgentNetworkGuardrailPromptCapture;
}
export declare function getAgentNetworkGuardrailOutput(args?: GetAgentNetworkGuardrailOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetAgentNetworkGuardrailResult>;
/**
 * A collection of arguments for invoking getAgentNetworkGuardrail.
 */
export interface GetAgentNetworkGuardrailOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getAgentNetworkGuardrail.d.ts.map