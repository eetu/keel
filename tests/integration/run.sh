#!/usr/bin/env bash
# Integration test for the device providers.
#
#   tests/integration/run.sh [tag]
#
# Boots the real image under podman with systemd as pid 1, gives it an ssh
# entrypoint, and drives RemoteFile + SystemdUnit through the full lifecycle:
# create, read, diff, update, drift detection, delete. State is a throwaway
# file:// backend in a temp directory, so nothing touches a real host or a real
# stack.
#
# The host is reached as an admin account with passwordless sudo, because the
# image's sshd policy refuses root and admits only members of its admin group —
# the same shape as a real host.
set -euo pipefail

tag="${1:-keel:raspo}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
name="keel-itest-$$"

# This directory's own Pulumi.yaml carries `nodeargs: "--import tsx"`, which is
# what loads the ESM TypeScript program: Pulumi's bundled ts-node delegates
# resolution to Node in ESM mode, which rejects extensionless relative imports.
#
# Serialisation is a separate problem with a separate fix — see src/infra/ssh.ts,
# which imports nothing at module scope.
#
# PULUMI_BACKEND_URL is the state location this directory's Pulumi.yaml
# deliberately leaves unset — a throwaway stack wants its state in this run's
# own temp directory, never the repo's real state/, which the root Pulumi.yaml
# points at.
export PULUMI_BACKEND_URL="file://${work}/state"
export PULUMI_CONFIG_PASSPHRASE="integration-test-only"
export PULUMI_SKIP_UPDATE_CHECK=true

cleanup() {
    podman rm -f "${name}" >/dev/null 2>&1 || true
    rm -rf "${work}"
}
trap cleanup EXIT

mkdir -p "${work}/state"
ssh-keygen -q -t ed25519 -N '' -f "${work}/key"

echo "== booting the image"
podman run -d --rm --name "${name}" --systemd=always \
    --cap-add NET_ADMIN,NET_RAW --publish 127.0.0.1:2222:22 \
    "${tag}" /sbin/init >/dev/null

for _ in $(seq 1 60); do
    if podman exec "${name}" systemctl is-active --quiet sshd.service; then break; fi
    sleep 1
done

# Both derived from the image rather than restated here, so the harness and the
# policy it logs in through cannot disagree. No ESP is mounted, so this container
# boots with keel-firstboot finding no keel.conf and creating nothing — the
# account below is the one the image would have made, created the same way.
admin=$(podman exec "${name}" sed -n 's/^admin=//p' /usr/bin/keel-firstboot)
group=$(podman exec "${name}" awk '/^AllowGroups/ { print $2 }' /etc/ssh/sshd_config)
echo "  admin user: ${admin}, in ${group}"

# In the group, because the group is the whole grant: sshd admits it and the
# image's sudoers drop-in gives it root, so an account outside it can neither log
# in nor deploy.
#
# '*' in the password field rather than the '!' useradd leaves: '*' means "no
# password" where '!' means "locked". OpenSSH gates its own locked-account check
# on `UsePAM no`, and this image sets `UsePAM yes` — which Fedora's build
# requires — so a key gets in either way and this only keeps the harness from
# depending on which side of that gate the image sits.
#
# No sudoers line here on purpose: the image ships its own grant for that group,
# and injecting one would hide it going missing.
podman exec "${name}" useradd --create-home --groups "${group}" "${admin}" 2>/dev/null || true
podman exec "${name}" usermod --password '*' "${admin}"
podman exec -i "${name}" sh -c "
    install -d -m 700 -o '${admin}' -g '${admin}' '/home/${admin}/.ssh'
    cat > '/home/${admin}/.ssh/authorized_keys'
    chown '${admin}:${admin}' '/home/${admin}/.ssh/authorized_keys'
    chmod 600 '/home/${admin}/.ssh/authorized_keys'
" < "${work}/key.pub"

# The image's packet filter admits SSH from the LAN and the two mesh ranges, and
# rootful podman publishes a port by DNAT, so the harness arrives as the bridge
# gateway and is dropped — correctly. (Rootless used a userspace proxy, so traffic
# appeared on loopback and passed `iif lo accept`; this test predates the switch
# to rootful, which image builds require.)
#
# Opened for the harness rather than worked around, because the alternative is
# either a podman network overlapping the real LAN or a relay through `podman
# exec`, and neither tests anything the QEMU tier does not already test properly:
# there the emulated network *is* in the allowed range, so the rule is exercised
# rather than bypassed. What this test is for is the providers.
podman exec "${name}" nft add rule inet keel input tcp dport 22 accept
echo "  SSH opened inside the test container (see the note in run.sh)"

cat > "${work}/ssh_config" <<EOF
Host keel-itest
    HostName 127.0.0.1
    Port 2222
    User ${admin}
    IdentityFile ${work}/key
    IdentitiesOnly yes
    # Without this the agent offers every key it holds before this one, and
    # the image's sshd allows three attempts — so a harness that reconnects
    # in a loop accumulates failures until its own fail2ban bans it. The same
    # trap the old repo's inventory pins an agent key to avoid.
    IdentityAgent none
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
    LogLevel ERROR
EOF

ssh() { command ssh -F "${work}/ssh_config" keel-itest "$@"; }

for _ in $(seq 1 30); do
    if ssh true 2>/dev/null; then break; fi
    sleep 1
done
ssh true || { echo "FAIL: ssh into the container never came up"; exit 1; }
echo "  ssh reachable"

# The identity lives only on the host, exactly as it will in production; the
# program is given nothing but the public recipient.
age-keygen -o "${work}/age.key" 2>"${work}/age.pub.txt"
recipient=$(awk '/Public key:/ { print $NF }' "${work}/age.pub.txt")
[ -n "${recipient}" ] || { echo "FAIL: could not read the age recipient"; exit 1; }
podman exec -i "${name}" sh -c 'install -D -m 600 /dev/stdin /etc/keel/age.key' \
    < "${work}/age.key"
echo "  age identity placed, recipient ${recipient}"

cd "${here}"
pulumi stack init itest >/dev/null
pulumi config set sshConfig "${work}/ssh_config" >/dev/null
pulumi config set ageRecipient "${recipient}" >/dev/null
pulumi config set secretPlaintext "TOKEN=first" >/dev/null

echo "== create"
pulumi up --yes --non-interactive --diff
ssh sudo test -f /etc/systemd/system/keel-itest.service \
    || { echo "FAIL: unit file not written"; exit 1; }
ssh systemctl is-active --quiet keel-itest.service \
    || { echo "FAIL: unit not active"; exit 1; }
echo "  unit file written and unit active"

# No manual decrypt: `keel-secrets.service` only runs at boot, which is the wrong
# moment for a secret that arrived from a deploy, so the provider decrypts as it
# writes — and this asserts that it does.
echo "== the secret decrypts on the host, without waiting for a reboot"
ssh sudo test -f /etc/secrets/keel-itest.env.age \
    || { echo "FAIL: blob not written"; exit 1; }
got=$(ssh sudo cat /etc/secrets/keel-itest.env)
[ "${got}" = "TOKEN=first" ] || { echo "FAIL: decrypted to '${got}'"; exit 1; }
echo "  decrypted to the plaintext, which never entered state"
ssh sudo grep -q 'BEGIN AGE ENCRYPTED FILE' /etc/secrets/keel-itest.env.age \
    || { echo "FAIL: the blob on disk is not age ciphertext"; exit 1; }

echo "== preview is empty when nothing changed"
if ! pulumi preview --non-interactive --expect-no-changes; then
    echo "FAIL: a second preview reported changes"
    exit 1
fi

# Piped into `tee` rather than redirected remotely: ssh joins its arguments and
# the remote shell re-parses them, so a `>>` would be applied by that shell as
# the login user instead of reaching sudo.
printf '# edited by hand\n' | ssh sudo tee -a /etc/systemd/system/keel-itest.service >/dev/null

# Asserted rather than assumed, because it is the operational rule that follows:
# a bare preview compares desired inputs against stored state and never consults
# the host, so drift is invisible until something refreshes.
echo "== a bare preview does not read the host"
if ! pulumi preview --non-interactive --expect-no-changes >/dev/null 2>&1; then
    echo "FAIL: preview reported drift without refreshing — state is being ignored"
    exit 1
fi
echo "  clean, as expected"

echo "== refresh reads the host and sees the drift"
if pulumi preview --refresh --non-interactive --expect-no-changes >/dev/null 2>&1; then
    echo "FAIL: --refresh missed a hand edit — read is not reaching the host"
    exit 1
fi
pulumi refresh --yes --non-interactive --diff
echo "  drift seen"

echo "== up restores the declared content"
pulumi up --yes --non-interactive --diff
ssh sudo grep -q 'edited by hand' /etc/systemd/system/keel-itest.service \
    && { echo "FAIL: hand edit survived"; exit 1; }
echo "  restored"

# The point of hashing the plaintext. Re-encrypting the same secret produces
# different ciphertext, so diffing on ciphertext would rewrite and restart on
# every deploy — this asserts it does not.
echo "== an unchanged secret is not rewritten"
if ! pulumi preview --non-interactive --expect-no-changes >/dev/null 2>&1; then
    echo "FAIL: unchanged secret reported a diff — age is not deterministic"
    pulumi preview --non-interactive --diff | tail -20
    exit 1
fi
echo "  no diff, despite fresh ciphertext"

echo "== rotating the secret rewrites it"
pulumi config set secretPlaintext "TOKEN=second" >/dev/null
pulumi up --yes --non-interactive >/dev/null
got=$(ssh sudo cat /etc/secrets/keel-itest.env)
[ "${got}" = "TOKEN=second" ] || { echo "FAIL: rotation left '${got}'"; exit 1; }
echo "  rotated"

echo "== update restarts the unit"
pulumi config set marker two >/dev/null
pulumi up --yes --non-interactive --diff
got=$(ssh sudo cat /run/keel-itest.marker)
[ "${got}" = "two" ] || { echo "FAIL: unit did not re-run, marker is '${got}'"; exit 1; }
echo "  marker updated to ${got}"

echo "== destroy removes both"
pulumi destroy --yes --non-interactive
ssh sudo test -f /etc/systemd/system/keel-itest.service \
    && { echo "FAIL: unit file survived destroy"; exit 1; }
ssh sudo test -f /etc/secrets/keel-itest.env \
    && { echo "FAIL: decrypted secret survived destroy"; exit 1; }
echo "  secret and its decrypted sibling gone"
state=$(ssh systemctl is-enabled keel-itest.service 2>&1 || true)
case "${state}" in
    *not-found* | *No\ such\ file*) echo "  unit and file gone" ;;
    *) echo "FAIL: unit still ${state} after destroy"; exit 1 ;;
esac

pulumi stack rm itest --yes >/dev/null
echo "all provider integration checks passed"
