import { dedent, file, merge, script, type Tree } from "./tree";

/**
 * Secrets reach a device as age ciphertext and are decrypted on it.
 *
 * Pulumi writes `/etc/secrets/<svc>.env.age`; the identity that opens it lives
 * only on the host, placed once by hand. So the state file holds a blob it
 * cannot read, the image holds no secret at all, and rotating one is a
 * `pulumi up` rather than an image rebuild and a reboot.
 *
 * Any `*.age` under /etc/secrets is decrypted to the same name without the
 * suffix, so a secret does not have to be an env file — a registry auth JSON or a
 * key file works the same way.
 *
 * Quadlets that need secrets order themselves after this unit and reference the
 * decrypted file with `EnvironmentFile=`, so no secret value is ever a resource
 * input.
 */
export function renderSecrets(): Tree {
  return merge(
    file(
      "/usr/lib/systemd/system/keel-secrets.service",
      dedent(`
        [Unit]
        Description=Decrypt keel secret blobs
        After=local-fs.target
        Before=multi-user.target
        ConditionPathExists=/etc/keel/age.key

        [Service]
        Type=oneshot
        RemainAfterExit=yes
        ExecStart=/usr/lib/keel/decrypt-secrets

        [Install]
        WantedBy=multi-user.target
      `),
    ),
    script(
      "/usr/lib/keel/decrypt-secrets",
      dedent(`
        #!/bin/sh
        set -eu

        key=/etc/keel/age.key

        for blob in /etc/secrets/*.age; do
            [ -e "$blob" ] || continue
            out="\${blob%.age}"
            # Decrypt to a temporary file and rename, so a reader never sees a
            # half-written env file and a failed decrypt leaves the old one intact.
            tmp="$out.new"
            age --decrypt --identity "$key" --output "$tmp" "$blob"
            chmod 600 "$tmp"
            mv "$tmp" "$out"
        done
      `),
    ),
  );
}
