/**
 * The board as a peer of the overlay it coordinates: the key on disk, the client
 * that must be on the machine to use it, and the enrolment itself.
 *
 * The daemon is not here. It is a package and a unit the image carries, for the
 * reason `src/render/mesh.ts` gives — so what this composes is the three things
 * an image cannot hold: a credential, a claim about the booted image, and the
 * one call that says which mesh this machine belongs to.
 *
 * The key never leaves the deploy in the clear. The coordinator minted it, the
 * bridged provider holds its plaintext as a secret output, `SealedText` turns
 * that into an age blob under the board's own identity, and the client is handed
 * the path the boot-time decrypt writes. Nothing between here and the board sees
 * the value, and neither does this module.
 */

import * as pulumi from "@pulumi/pulumi";

import { SECRETS_DIR } from "../config/spec";
import { KEEL_MESH_SERVICE, MESH_AGENT_BINARY, MESH_STATE_DIR } from "../render/mesh";
import { MeshEnrolment } from "./providers/meshEnrolment";
import { RemoteBinary } from "./providers/remoteBinary";
import { SealedText } from "./providers/sealedText";
import { SecretFile } from "./providers/secretFile";

export type MeshAgentArgs = {
  /** The entry that declared the mesh. Every resource here is named after it. */
  name: string;
  /** ssh_config alias of the board being enrolled. */
  host: string;
  /** Public half of the age identity on that board. */
  ageRecipient: string;
  /** The coordinator's public origin — what this peer is told to dial. */
  managementUrl: string;
  /** The name the peer registers under, which is the routing peer's own. */
  hostname: string;
  /** The key's plaintext, a secret output of the resource that created it. */
  setupKey: pulumi.Input<string>;
  /** The WireGuard port, or null for the client's own default. */
  wireguardPort: number | null;
  /** Extra ssh arguments — an alternate config file, a jump host, a port. */
  sshArgs?: readonly string[];
};

export default class MeshAgent extends pulumi.ComponentResource {
  /** What the routes and the DNS group are ordered behind: a peer that exists. */
  public readonly enrolment: MeshEnrolment;

  constructor(args: MeshAgentArgs, opts?: pulumi.ComponentResourceOptions) {
    const { name, host, ageRecipient, managementUrl, hostname, setupKey, wireguardPort, sshArgs } =
      args;
    super("keel:index:MeshAgent", `${name}-agent`, {}, opts);
    const parent = { parent: this };

    // Directly under /etc/secrets and with no suffix of its own, because that is
    // the whole of what `keel-secrets.service` opens: `<path>.age` in, `<path>`
    // out, mode 600, root. A blob anywhere else is written correctly, never
    // decrypted, and discovered as a client that cannot read its own key.
    const keyPath = `${SECRETS_DIR}/${name}.setup-key`;
    const sealed = new SealedText(
      `${name}-setup-key`,
      // Stated rather than inherited: the provider marks the key secret, and a
      // body that reached the checkpoint on whatever secretness the engine
      // happened to infer would be a credential in the clear.
      { plaintext: pulumi.secret(pulumi.output(setupKey)), ageRecipient },
      parent,
    );
    const keyFile = new SecretFile(
      `${name}-setup-key-file`,
      {
        host,
        sshArgs,
        path: `${keyPath}.age`,
        ciphertext: sealed.ciphertext,
        plaintextHash: sealed.plaintextHash,
      },
      parent,
    );

    // The client is image content, so a board whose booted image predates it has
    // nothing to enrol with — and the failure without this probe is a shell
    // error about a missing command, some way into a run, naming nothing that
    // says what to do about it.
    const client = new RemoteBinary(
      `${name}-agent-binary`,
      {
        host,
        sshArgs,
        path: MESH_AGENT_BINARY,
        installedBy: "the image",
        neededBy: "this board's own enrolment on the mesh",
      },
      parent,
    );

    this.enrolment = new MeshEnrolment(
      `${name}-enrolment`,
      {
        host,
        sshArgs,
        binary: MESH_AGENT_BINARY,
        stateDir: MESH_STATE_DIR,
        unit: KEEL_MESH_SERVICE,
        managementUrl,
        hostname,
        setupKeyPath: keyPath,
        wireguardPort,
      },
      { ...parent, dependsOn: [keyFile, client] },
    );

    this.registerOutputs({ address: this.enrolment.address });
  }
}
