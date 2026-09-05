import * as pulumi from "@pulumi/pulumi";
import * as inputs from "./types/input";
import * as outputs from "./types/output";
export declare class AgentNetworkProvider extends pulumi.CustomResource {
    /**
     * Get an existing AgentNetworkProvider resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     * @param opts Optional settings to control the behavior of the CustomResource.
     */
    static get(name: string, id: pulumi.Input<pulumi.ID>, state?: AgentNetworkProviderState, opts?: pulumi.CustomResourceOptions): AgentNetworkProvider;
    /**
     * Returns true if the given object is an instance of AgentNetworkProvider.  This is designed to work even
     * when multiple copies of the Pulumi SDK have been loaded into the same process.
     */
    static isInstance(obj: any): obj is AgentNetworkProvider;
    /**
     * Upstream provider API key. Sealed at rest; never returned in responses. Required on create; omit on update to keep the existing key.
     */
    readonly apiKey: pulumi.Output<string>;
    /**
     * Whether the provider is enabled
     */
    readonly enabled: pulumi.Output<boolean>;
    /**
     * Catalog-specific extra header values (e.g. `x-portkey-config` for Portkey gateways). Omit to leave the stored values unchanged. Empty values are dropped by the API.
     */
    readonly extraValues: pulumi.Output<{
        [key: string]: string;
    }>;
    /**
     * Wire header name the proxy stamps with the caller's NetBird groups as a comma-separated list
     */
    readonly identityHeaderGroups: pulumi.Output<string>;
    /**
     * Wire header name the proxy stamps with the caller's display identity
     */
    readonly identityHeaderUserId: pulumi.Output<string>;
    /**
     * Suppress identity-metadata injection for this provider (e.g. the AWS Bedrock request-metadata header). Omit to leave the stored value unchanged.
     */
    readonly metadataDisabled: pulumi.Output<boolean>;
    /**
     * Models exposed through this endpoint with per-1k token prices. Empty means all catalog models at catalog prices.
     */
    readonly models: pulumi.Output<outputs.AgentNetworkProviderModel[]>;
    /**
     * Display name shown in the dashboard
     */
    readonly name: pulumi.Output<string>;
    /**
     * Catalog identifier for the upstream AI provider (e.g. <span pulumi-lang-nodejs="`openaiApi`" pulumi-lang-dotnet="`OpenaiApi`" pulumi-lang-go="`openaiApi`" pulumi-lang-python="`openai_api`" pulumi-lang-yaml="`openaiApi`" pulumi-lang-java="`openaiApi`" pulumi-lang-hcl="`openai_api`">`openaiApi`</span>, <span pulumi-lang-nodejs="`anthropicApi`" pulumi-lang-dotnet="`AnthropicApi`" pulumi-lang-go="`anthropicApi`" pulumi-lang-python="`anthropic_api`" pulumi-lang-yaml="`anthropicApi`" pulumi-lang-java="`anthropicApi`" pulumi-lang-hcl="`anthropic_api`">`anthropicApi`</span>, <span pulumi-lang-nodejs="`custom`" pulumi-lang-dotnet="`Custom`" pulumi-lang-go="`custom`" pulumi-lang-python="`custom`" pulumi-lang-yaml="`custom`" pulumi-lang-java="`custom`" pulumi-lang-hcl="`custom`">`custom`</span>)
     */
    readonly providerId: pulumi.Output<string>;
    /**
     * Skip upstream TLS certificate verification (for self-hosted gateways with private certificates)
     */
    readonly skipTlsVerification: pulumi.Output<boolean>;
    /**
     * Full upstream URL (with scheme) that NetBird forwards traffic to
     */
    readonly upstreamUrl: pulumi.Output<string>;
    /**
     * Create a AgentNetworkProvider resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args: AgentNetworkProviderArgs, opts?: pulumi.CustomResourceOptions);
}
/**
 * Input properties used for looking up and filtering AgentNetworkProvider resources.
 */
export interface AgentNetworkProviderState {
    /**
     * Upstream provider API key. Sealed at rest; never returned in responses. Required on create; omit on update to keep the existing key.
     */
    apiKey?: pulumi.Input<string | undefined>;
    /**
     * Whether the provider is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Catalog-specific extra header values (e.g. `x-portkey-config` for Portkey gateways). Omit to leave the stored values unchanged. Empty values are dropped by the API.
     */
    extraValues?: pulumi.Input<{
        [key: string]: pulumi.Input<string>;
    } | undefined>;
    /**
     * Wire header name the proxy stamps with the caller's NetBird groups as a comma-separated list
     */
    identityHeaderGroups?: pulumi.Input<string | undefined>;
    /**
     * Wire header name the proxy stamps with the caller's display identity
     */
    identityHeaderUserId?: pulumi.Input<string | undefined>;
    /**
     * Suppress identity-metadata injection for this provider (e.g. the AWS Bedrock request-metadata header). Omit to leave the stored value unchanged.
     */
    metadataDisabled?: pulumi.Input<boolean | undefined>;
    /**
     * Models exposed through this endpoint with per-1k token prices. Empty means all catalog models at catalog prices.
     */
    models?: pulumi.Input<pulumi.Input<inputs.AgentNetworkProviderModel>[] | undefined>;
    /**
     * Display name shown in the dashboard
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Catalog identifier for the upstream AI provider (e.g. <span pulumi-lang-nodejs="`openaiApi`" pulumi-lang-dotnet="`OpenaiApi`" pulumi-lang-go="`openaiApi`" pulumi-lang-python="`openai_api`" pulumi-lang-yaml="`openaiApi`" pulumi-lang-java="`openaiApi`" pulumi-lang-hcl="`openai_api`">`openaiApi`</span>, <span pulumi-lang-nodejs="`anthropicApi`" pulumi-lang-dotnet="`AnthropicApi`" pulumi-lang-go="`anthropicApi`" pulumi-lang-python="`anthropic_api`" pulumi-lang-yaml="`anthropicApi`" pulumi-lang-java="`anthropicApi`" pulumi-lang-hcl="`anthropic_api`">`anthropicApi`</span>, <span pulumi-lang-nodejs="`custom`" pulumi-lang-dotnet="`Custom`" pulumi-lang-go="`custom`" pulumi-lang-python="`custom`" pulumi-lang-yaml="`custom`" pulumi-lang-java="`custom`" pulumi-lang-hcl="`custom`">`custom`</span>)
     */
    providerId?: pulumi.Input<string | undefined>;
    /**
     * Skip upstream TLS certificate verification (for self-hosted gateways with private certificates)
     */
    skipTlsVerification?: pulumi.Input<boolean | undefined>;
    /**
     * Full upstream URL (with scheme) that NetBird forwards traffic to
     */
    upstreamUrl?: pulumi.Input<string | undefined>;
}
/**
 * The set of arguments for constructing a AgentNetworkProvider resource.
 */
export interface AgentNetworkProviderArgs {
    /**
     * Upstream provider API key. Sealed at rest; never returned in responses. Required on create; omit on update to keep the existing key.
     */
    apiKey: pulumi.Input<string>;
    /**
     * Whether the provider is enabled
     */
    enabled?: pulumi.Input<boolean | undefined>;
    /**
     * Catalog-specific extra header values (e.g. `x-portkey-config` for Portkey gateways). Omit to leave the stored values unchanged. Empty values are dropped by the API.
     */
    extraValues?: pulumi.Input<{
        [key: string]: pulumi.Input<string>;
    } | undefined>;
    /**
     * Wire header name the proxy stamps with the caller's NetBird groups as a comma-separated list
     */
    identityHeaderGroups?: pulumi.Input<string | undefined>;
    /**
     * Wire header name the proxy stamps with the caller's display identity
     */
    identityHeaderUserId?: pulumi.Input<string | undefined>;
    /**
     * Suppress identity-metadata injection for this provider (e.g. the AWS Bedrock request-metadata header). Omit to leave the stored value unchanged.
     */
    metadataDisabled?: pulumi.Input<boolean | undefined>;
    /**
     * Models exposed through this endpoint with per-1k token prices. Empty means all catalog models at catalog prices.
     */
    models?: pulumi.Input<pulumi.Input<inputs.AgentNetworkProviderModel>[] | undefined>;
    /**
     * Display name shown in the dashboard
     */
    name?: pulumi.Input<string | undefined>;
    /**
     * Catalog identifier for the upstream AI provider (e.g. <span pulumi-lang-nodejs="`openaiApi`" pulumi-lang-dotnet="`OpenaiApi`" pulumi-lang-go="`openaiApi`" pulumi-lang-python="`openai_api`" pulumi-lang-yaml="`openaiApi`" pulumi-lang-java="`openaiApi`" pulumi-lang-hcl="`openai_api`">`openaiApi`</span>, <span pulumi-lang-nodejs="`anthropicApi`" pulumi-lang-dotnet="`AnthropicApi`" pulumi-lang-go="`anthropicApi`" pulumi-lang-python="`anthropic_api`" pulumi-lang-yaml="`anthropicApi`" pulumi-lang-java="`anthropicApi`" pulumi-lang-hcl="`anthropic_api`">`anthropicApi`</span>, <span pulumi-lang-nodejs="`custom`" pulumi-lang-dotnet="`Custom`" pulumi-lang-go="`custom`" pulumi-lang-python="`custom`" pulumi-lang-yaml="`custom`" pulumi-lang-java="`custom`" pulumi-lang-hcl="`custom`">`custom`</span>)
     */
    providerId: pulumi.Input<string>;
    /**
     * Skip upstream TLS certificate verification (for self-hosted gateways with private certificates)
     */
    skipTlsVerification?: pulumi.Input<boolean | undefined>;
    /**
     * Full upstream URL (with scheme) that NetBird forwards traffic to
     */
    upstreamUrl: pulumi.Input<string>;
}
//# sourceMappingURL=agentNetworkProvider.d.ts.map