import * as pulumi from "@pulumi/pulumi";
export declare function getUser(args?: GetUserArgs, opts?: pulumi.InvokeOptions): Promise<GetUserResult>;
/**
 * A collection of arguments for invoking getUser.
 */
export interface GetUserArgs {
    email?: string;
    id?: string;
    name?: string;
}
/**
 * A collection of values returned by getUser.
 */
export interface GetUserResult {
    readonly autoGroups: string[];
    readonly email: string;
    readonly id: string;
    readonly isBlocked: boolean;
    readonly isCurrent: boolean;
    readonly isServiceUser: boolean;
    readonly issued: string;
    readonly lastLogin: string;
    readonly name: string;
    readonly role: string;
    readonly status: string;
}
export declare function getUserOutput(args?: GetUserOutputArgs, opts?: pulumi.InvokeOutputOptions): pulumi.Output<GetUserResult>;
/**
 * A collection of arguments for invoking getUser.
 */
export interface GetUserOutputArgs {
    email?: pulumi.Input<string | undefined>;
    id?: pulumi.Input<string | undefined>;
    name?: pulumi.Input<string | undefined>;
}
//# sourceMappingURL=getUser.d.ts.map