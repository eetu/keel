import * as pulumi from "@pulumi/pulumi";
import * as outputs from "./types/output";
export declare function getNameserverGroup(args?: GetNameserverGroupArgs, opts?: pulumi.InvokeOptions): Promise<GetNameserverGroupResult>;
/**
 * A collection of arguments for invoking getNameserverGroup.
 */
export interface GetNameserverGroupArgs {
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getNameserverGroup.
 */
export interface GetNameserverGroupResult {
    readonly description: string;
    readonly domains: string[];
    readonly enabled: boolean;
    readonly groups: string[];
    readonly id: string;
    readonly name: string;
    readonly nameservers: outputs.GetNameserverGroupNameserver[];
    readonly primary: boolean;
    readonly searchDomainsEnabled: boolean;
}
export declare function getNameserverGroupOutput(args?: GetNameserverGroupOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetNameserverGroupResult>;
/**
 * A collection of arguments for invoking getNameserverGroup.
 */
export interface GetNameserverGroupOutputArgs {
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getNameserverGroup.d.ts.map