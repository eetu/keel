import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class ReverseProxyService extends pulumi.CustomResource {
    /**
     * Get an existing ReverseProxyService resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: ReverseProxyServiceState, opts?: pulumi.CustomResourceOptions): ReverseProxyService;
    /**
     * Returns true if the given object is an instance of ReverseProxyService.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is ReverseProxyService;
    /**
     * Connection-level access restrictions based on IP or geography
     */
    readonly accessRestrictions: pulumi.Output<outputs.ReverseProxyServiceAccessRestrictions | undefined>;
    /**
     * Authentication configuration
     */
    readonly auth: pulumi.Output<outputs.ReverseProxyServiceAuth>;
    /**
     * Domain for the service
     */
    readonly domain: pulumi.Output<string>;
    /**
     * Whether the service is enabled
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Port the proxy listens on (L4/TLS only). Set to 0 for auto-assignment.
     */
    readonly listenPort: pulumi.Output<number>;
    /**
     * Service mode: "http" for L7 reverse proxy, "tcp"/"udp"/"tls" for L4 passthrough
     */
    readonly mode: pulumi.Output<string>;
    /**
     * Service name
     */
    readonly name: pulumi.Output<string>;
    /**
     * When true, the original client Host header is passed through to the backend
     */
    readonly passHostHeader: pulumi.Output<boolean>;
    /**
     * Whether the listen port was auto-assigned by the server
     */
    readonly portAutoAssigned: pulumi.Output<boolean>;
    /**
     * The proxy cluster handling this service (derived from domain)
     */
    readonly proxyCluster: pulumi.Output<string>;
    /**
     * When true, Location headers in backend responses are rewritten to replace the backend address with the public-facing domain
     */
    readonly rewriteRedirects: pulumi.Output<boolean>;
    /**
     * List of target backends for this service
     */
    readonly targets: pulumi.Output<outputs.ReverseProxyServiceTarget[]>;
    /**
     * Create a ReverseProxyService resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: ReverseProxyServiceArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering ReverseProxyService resources.
 */
export interface ReverseProxyServiceState {
    /**
     * Connection-level access restrictions based on IP or geography
     */
    accessRestrictions?: pulumi.Input<inputs.ReverseProxyServiceAccessRestrictions | undefined>;
    /**
     * Authentication configuration
     */
    auth?: pulumi.Input<inputs.ReverseProxyServiceAuth | undefined>;
    /**
     * Domain for the service
     */
    domain?: pulumi.Input<string | undefined>;
    /**
     * Whether the service is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Port the proxy listens on (L4/TLS only). Set to 0 for auto-assignment.
     */
    listenPort?: pulumi.Input<number | undefined>;
    /**
     * Service mode: "http" for L7 reverse proxy, "tcp"/"udp"/"tls" for L4 passthrough
     */
    mode?: pulumi.Input<string | undefined>;
    /**
     * Service name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * When true, the original client Host header is passed through to the backend
     */
    passHostHeader?: pulumi.Input<boolean | undefined>;
    /**
     * Whether the listen port was auto-assigned by the server
     */
    portAutoAssigned?: pulumi.Input<boolean | undefined>;
    /**
     * The proxy cluster handling this service (derived from domain)
     */
    proxyCluster?: pulumi.Input<string | undefined>;
    /**
     * When true, Location headers in backend responses are rewritten to replace the backend address with the public-facing domain
     */
    rewriteRedirects?: pulumi.Input<boolean | undefined>;
    /**
     * List of target backends for this service
     */
    targets?: pulumi.Input<pulumi.Input<inputs.ReverseProxyServiceTarget>[] | undefined>;
}
/**
 * The set of arguments for constructing a ReverseProxyService resource.
 */
export interface ReverseProxyServiceArgs {
    /**
     * Connection-level access restrictions based on IP or geography
     */
    accessRestrictions?: pulumi.Input<inputs.ReverseProxyServiceAccessRestrictions | undefined>;
    /**
     * Authentication configuration
     */
    auth: pulumi.Input<inputs.ReverseProxyServiceAuth>;
    /**
     * Domain for the service
     */
    domain: pulumi.Input<string>;
    /**
     * Whether the service is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Port the proxy listens on (L4/TLS only). Set to 0 for auto-assignment.
     */
    listenPort?: pulumi.Input<number | undefined>;
    /**
     * Service mode: "http" for L7 reverse proxy, "tcp"/"udp"/"tls" for L4 passthrough
     */
    mode?: pulumi.Input<string | undefined>;
    /**
     * Service name
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * When true, the original client Host header is passed through to the backend
     */
    passHostHeader?: pulumi.Input<boolean | undefined>;
    /**
     * When true, Location headers in backend responses are rewritten to replace the backend address with the public-facing domain
     */
    rewriteRedirects?: pulumi.Input<boolean | undefined>;
    /**
     * List of target backends for this service
     */
    targets: pulumi.Input<pulumi.Input<inputs.ReverseProxyServiceTarget>[]>;
}
//# sourceMappingURL=reverseProxyService.d.ts.map