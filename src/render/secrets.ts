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
            #
            # mktemp and not "$out.new": every SecretFile's create and update runs
            # this script over *every* blob, and a deploy writes several at once.
            # With one fixed name two concurrent runs raced — both wrote it, the
            # first renamed it, and the second's mv failed on a file that was no
            # longer there. \`set -e\` then killed the loser part-way through, so a
            # resource reported failure and the secrets after it in the glob were
            # never written. A private name per run makes the concurrency harmless:
            # each writes its own file and renames it over the same destination,
            # and rename(2) is atomic, so a reader sees one whole version or the
            # other.
            tmp="$(mktemp "$out.XXXXXX")"
            chmod 600 "$tmp"
            # The temporary file is this run's, so a failure has to remove it —
            # otherwise a decrypt that dies leaves a stray beside the real one,
            # and the next run's glob does not clean it up.
            if ! age --decrypt --identity "$key" --output "$tmp" "$blob"; then
                rm -f "$tmp"
                exit 1
            fi
            mv "$tmp" "$out"
        done
      `),
    ),
  );
}
