import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class PostureCheck extends pulumi.CustomResource {
    /**
     * Get an existing PostureCheck resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: PostureCheckState, opts?: pulumi.CustomResourceOptions): PostureCheck;
    /**
     * Returns true if the given object is an instance of PostureCheck.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is PostureCheck;
    /**
     * PostureCheck description
     */
    readonly description: pulumi.Output<string | undefined>;
    readonly geoLocationCheck: pulumi.Output<outputs.PostureCheckGeoLocationCheck | undefined>;
    /**
     * PostureCheck Name
     */
    readonly name: pulumi.Output<string>;
    readonly netbirdVersionCheck: pulumi.Output<outputs.PostureCheckNetbirdVersionCheck | undefined>;
    readonly osVersionCheck: pulumi.Output<outputs.PostureCheckOsVersionCheck | undefined>;
    readonly peerNetworkRangeCheck: pulumi.Output<outputs.PostureCheckPeerNetworkRangeCheck | undefined>;
    readonly processChecks: pulumi.Output<outputs.PostureCheckProcessCheck[] | undefined>;
    /**
     * Create a PostureCheck resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: PostureCheckArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering PostureCheck resources.
 */
export interface PostureCheckState {
    /**
     * PostureCheck description
     */
    description?: pulumi.Input<string | undefined>;
    geoLocationCheck?: pulumi.Input<inputs.PostureCheckGeoLocationCheck | undefined>;
    /**
     * PostureCheck Name
     */
    name?: pulumi.Input<string | undefined>;
    netbirdVersionCheck?: pulumi.Input<inputs.PostureCheckNetbirdVersionCheck | undefined>;
    osVersionCheck?: pulumi.Input<inputs.PostureCheckOsVersionCheck | undefined>;
    peerNetworkRangeCheck?: pulumi.Input<inputs.PostureCheckPeerNetworkRangeCheck | undefined>;
    processChecks?: pulumi.Input<pulumi.Input<inputs.PostureCheckProcessCheck>[] | undefined>;
}
/**
 * The set of arguments for constructing a PostureCheck resource.
 */
export interface PostureCheckArgs {
    /**
     * PostureCheck description
     */
    description?: pulumi.Input<string | undefined>;
    geoLocationCheck?: pulumi.Input<inputs.PostureCheckGeoLocationCheck | undefined>;
    /**
     * PostureCheck Name
     */
    name?: pulumi.Input<string | undefined>;
    netbirdVersionCheck?: pulumi.Input<inputs.PostureCheckNetbirdVersionCheck | undefined>;
    osVersionCheck?: pulumi.Input<inputs.PostureCheckOsVersionCheck | undefined>;
    peerNetworkRangeCheck?: pulumi.Input<inputs.PostureCheckPeerNetworkRangeCheck | undefined>;
    processChecks?: pulumi.Input<pulumi.Input<inputs.PostureCheckProcessCheck>[] | undefined>;
}
//# sourceMappingURL=postureCheck.d.ts.map