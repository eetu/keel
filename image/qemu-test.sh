#!/usr/bin/env bash
# Tier 3: build a disk image and boot it under QEMU.
#
#   image/qemu-test.sh [tag] [compat|service] [--pulumi] [--host <name>]
#
# The only tier on a development machine that runs a real kernel and a real
# bootloader. Two modes, because the CPU model and the speed are a trade:
#
#   compat  (default)  -cpu cortex-a72, which forces TCG emulation. Slow, and the
#                      point: an accelerated guest runs the *host's* CPU, so only
#                      this can reproduce an illegal instruction in a build that
#                      assumed something newer than a Pi 4's A72.
#   service            -cpu host with HVF, near native. For anything where the
#                      work matters more than the instruction set — pulling
#                      container images, running the service stack, `pulumi up`
#                      against the guest.
#
# `-m 1024` in both, matching the boards in the fleet, so the memory generator
# picks the same profile it will pick on hardware — and so the service mode
# answers whether the fleet actually fits in 1 GB before any card is written.
#
# Things that only work here, never in the container tier: zram, systemd-oomd,
# polkit, and greenboot's bootloader interaction — the mechanism that decides
# whether a bad image rolls itself back.
set -euo pipefail

tag="keel:latest"
mode="compat"
# With --pulumi the guest is also used as a deploy target, which is the only way
# to exercise the configuration layer against a real kernel, real systemd and real
# podman before a card is written.
with_pulumi=""
# Which host's Pulumi config to deploy under --pulumi — decoupled from the image
# tag, since one generic image serves every host.
#
# Deliberately without a default. The deployed set is everything that host's
# `services` list carries — the whole catalog when it has none — and there is no
# subset to narrow it to: a guest given `raspi` gets every service raspi runs,
# which means real vault reads, a real DNS-01 challenge for the real zone against
# the registrar's API, and the certificate that comes back counted against that
# zone's issuance limits. That is a thing to ask for by name, not to fall into.
# The host must also deploy the resolver, or the check below has nothing to check.
pulumi_host=""
positional=()

# A manual loop rather than getopts, so --pulumi and --host can appear before,
# between or after the positional tag and mode — getopts stops at the first
# non-option argument.
while [ $# -gt 0 ]; do
    case "$1" in
        --pulumi) with_pulumi="--pulumi"; shift ;;
        --host) pulumi_host="${2:?--host needs a value}"; shift 2 ;;
        *) positional+=("$1"); shift ;;
    esac
done
[ "${#positional[@]}" -ge 1 ] && tag="${positional[0]}"
[ "${#positional[@]}" -ge 2 ] && mode="${positional[1]}"

# Refused up front rather than after a twenty-minute boot: the deploy is the last
# thing this script does.
if [ "${with_pulumi}" = "--pulumi" ] && [ -z "${pulumi_host}" ]; then
    echo "--pulumi needs --host <name>: the guest gets every service that host runs —"
    echo "real vault reads and a real DNS-01 challenge for the real zone included."
    exit 2
fi

case "${mode}" in
    compat) machine_args=(-machine virt -cpu cortex-a72) ;;
    service) machine_args=(-machine virt,accel=hvf -cpu host) ;;
    *) echo "usage: image/qemu-test.sh [tag] [compat|service] [--pulumi] [--host <name>]"; exit 2 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "${here}")"
out="${repo}/build/qemu"
work="$(mktemp -d)"

# shellcheck source=image/lib.sh
source "${here}/lib.sh"

QEMU_PID=""
cleanup() {
    if [ -n "${QEMU_PID}" ]; then kill "${QEMU_PID}" 2>/dev/null || true; fi
    rm -rf "${work}"
}
trap cleanup EXIT

mkdir -p "${out}"
# The admin's identity for this run. The image ships no account and no key — the
# key arrives from keel.conf, sideloaded onto the ESP below, and the account is
# made by keel-firstboot when it reads that file — so this is the only place
# either exists.
ssh-keygen -q -t ed25519 -N '' -f "${work}/key"

# Which account that will be, asked of the image rather than restated here: its
# sshd admits a group and names nobody, so the name lives in exactly one place.
admin=$(podman run --rm "${tag}" sed -n 's/^admin=//p' /usr/bin/keel-firstboot)
[ -n "${admin}" ] || { echo "FAIL: the image names no admin account"; exit 1; }
echo "  admin account: ${admin}"

echo "== building a disk image from ${tag}"
run_bib "${tag}" "${out}"

disk=$(find "${out}" -name '*.raw' | head -1)
[ -n "${disk}" ] || { echo "FAIL: no raw disk produced"; exit 1; }
echo "  disk: ${disk} ($(du -h "${disk}" | cut -f1))"

# A run interrupted before its trap fires leaves QEMU holding this disk, and the
# next run then fails at `qemu-img resize` with a write-lock error that looks
# nothing like its cause.
if pkill -f "qemu-system-aarch64.*${disk}" 2>/dev/null; then
    echo "  stopped a QEMU still holding the disk from an earlier run"
    sleep 2
fi

# Grown to 16 GB before boot, which is precisely what flashing this image onto a
# 16 GB card looks like: a small image on a large medium, with the rest
# unallocated until keel-growfs claims it. Asserted after boot.
before_bytes=$(file_size_bytes "${disk}")
qemu-img resize -f raw "${disk}" 16G >/dev/null
echo "  resized to 16G to exercise keel-growfs (was $((before_bytes / 1024 / 1024)) MB)"

# UEFI needs a writable variable store of its own.
cp "${QEMU_FIRMWARE}/edk2-arm-vars.fd" "${work}/vars.fd"

# QEMU's own default subnet for user-mode networking. The guest gets no LAN
# CIDR of its own until keel-firstboot applies keel.conf, so rather than
# reading one out of the image and pointing QEMU at it, the harness writes this
# network into keel.conf below — the same real path a card takes, just with an
# address that happens to be the one QEMU already puts the guest on.
lan_cidr="10.0.2.0/24"
host_ip="10.0.2.2"
echo "  emulated network: ${lan_cidr}, host as ${host_ip}"

echo "== sideloading a throwaway keel.conf onto the ESP"
cat > "${work}/keel.conf" <<EOF
KEEL_HOSTNAME=qemu-keel
KEEL_ADMIN_KEY=$(cat "${work}/key.pub")
KEEL_LAN_CIDR=${lan_cidr}
EOF
basename "${disk}" > "${work}/diskname"
cat > "${work}/inject-keelconf.sh" <<'INNER'
set -eu
dnf -y install --quiet jq util-linux >/dev/null

disk="/image/$(cat /w/diskname)"

esp_guid="C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
read -r start size <<EOF
$(sfdisk --json "$disk" 2>/dev/null | jq -r --arg g "$esp_guid" \
    '.partitiontable.partitions[]
     | select((.type | ascii_upcase) == $g)
     | "\(.start) \(.size)"' | head -1)
EOF
[ -n "$start" ] || { echo "FAIL: no EFI System partition in the image"; exit 1; }

mkdir -p /mnt/esp
mount -o "loop,offset=$((start * 512)),sizelimit=$((size * 512))" "$disk" /mnt/esp
trap 'umount /mnt/esp' EXIT
cp /w/keel.conf /mnt/esp/keel.conf
sync
INNER
podman run --rm --privileged \
    --volume "$(dirname "${disk}"):/image" \
    --volume "${work}:/w" \
    quay.io/fedora/fedora:43 bash /w/inject-keelconf.sh

if [ "${mode}" = compat ]; then
    echo "== booting under QEMU (cortex-a72, TCG — this is slow, and deliberate)"
else
    echo "== booting under QEMU (host CPU, HVF)"
fi
started=$(date +%s)
boot_disk_under_qemu "${disk}" "${work}/vars.fd" "${work}/console.log" \
    "${machine_args[@]}" \
    -netdev "user,id=net0,net=${lan_cidr},host=${host_ip},hostfwd=tcp:127.0.0.1:2244-:22" \
    -device virtio-net-pci,netdev=net0

cat > "${work}/ssh_config" <<EOF
Host keel-qemu
    HostName 127.0.0.1
    Port 2244
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
    ConnectTimeout 5
EOF

ssh() { command ssh -F "${work}/ssh_config" keel-qemu "$@"; }

echo "  waiting for ssh (up to 15 minutes under emulation)"
for i in $(seq 1 180); do
    if ssh true 2>/dev/null; then break; fi
    if ! kill -0 "${QEMU_PID}" 2>/dev/null; then
        echo "FAIL: QEMU exited early"
        tail -40 "${work}/console.log"
        exit 1
    fi
    if [ "$((i % 12))" = 0 ]; then echo "    ...still booting (${i}0s)"; fi
    sleep 5
done
ssh true 2>/dev/null || {
    echo "FAIL: never reached ssh"
    tail -60 "${work}/console.log"
    exit 1
}
echo "  booted in $(( $(date +%s) - started ))s (${mode} mode)"

# The real firstboot path, exercised the same way a card is: ssh already having
# worked above proves keel-firstboot created the account, put it in the group
# sshd admits, and installed the key from keel.conf — the image ships none of the
# three. What is left to check is the rest of what that same file drove — the
# hostname, and the packet filter admitting the network keel-firstboot was told
# the guest is on.
echo "== keel-firstboot applied keel.conf"
hostname=$(ssh cat /etc/hostname)
[ "${hostname}" = qemu-keel ] || { echo "FAIL: hostname is '${hostname}', not qemu-keel"; exit 1; }
echo "  hostname: ${hostname}"
ssh sudo nft list set inet keel lan4 | grep -q "${lan_cidr}" || {
    echo "FAIL: lan4 does not contain ${lan_cidr}"
    ssh sudo nft list set inet keel lan4 || true
    exit 1
}
echo "  lan4 admits ${lan_cidr}"

echo "== bootc sees itself"
ssh sudo bootc status --format=json | head -30

# The renderer ships this as a kargs.d entry rather than an fstab option
# because bootc composes the root mount itself; whether bootc-image-builder's
# own install carries a kargs.d entry through onto the disk it writes, as
# opposed to only a later `bootc upgrade`, is what this checks — it is
# unverified until a run gets here.
echo "== root mounted noatime"
opts=$(ssh findmnt -no OPTIONS /sysroot)
case ",${opts}," in
    *,noatime,*) echo "  /sysroot: ${opts}" ;;
    *) echo "FAIL: /sysroot mount options carry no noatime: ${opts}"; exit 1 ;;
esac

echo "== the memory generator picked a profile"
profile=$(ssh readlink /run/systemd/generator/vaultwarden.service.d/50-keel-memory.conf 2>/dev/null || true)
case "${profile}" in
    */1g/*) echo "  1g, as expected for 1024 MB" ;;
    "") echo "  no drop-in staged (expected until services are in the image)" ;;
    *) echo "FAIL: staged ${profile} on a 1024 MB guest"; exit 1 ;;
esac

echo "== keel-growfs claimed the rest of the disk"
root_gb=$(ssh "df --block-size=1G --output=size /sysroot | tail -1 | tr -d ' '")
echo "  root filesystem: ${root_gb} GB of a 16 GB disk"
[ "${root_gb}" -ge 12 ] || {
    echo "FAIL: root did not grow — the image's own size would be ~2 GB"
    ssh systemctl status keel-growfs.service --no-pager || true
    exit 1
}

# The tier where this is decidable at all: a container shares the host kernel's
# SELinux state, so no amount of podman testing can say whether unbound may bind
# a port the policy has not been taught about.
echo "== unbound binds its port with SELinux enforcing"
mode=$(ssh getenforce)
[ "${mode}" = Enforcing ] || {
    echo "FAIL: SELinux is '${mode}' — this check proves nothing unless enforcing"
    exit 1
}
# Waited for, not sampled: semanage compiles a policy module, which is most of a
# minute on an emulated A72 and no faster on a Pi 3. unbound is ordered after it
# and so is still activating for that whole window.
settled() {
    local unit="$1" state=""
    for _ in $(seq 1 90); do
        state=$(ssh systemctl is-active "${unit}" 2>/dev/null || true)
        case "${state}" in
            active | failed | inactive) break ;;
        esac
        sleep 2
    done
    printf '%s' "${state}"
}
label_state=$(settled keel-selinux.service)
[ "${label_state}" = active ] || {
    echo "FAIL: keel-selinux.service is '${label_state:-unknown}'"
    ssh sudo journalctl -u keel-selinux.service -n 30 --no-pager || true
    exit 1
}
# Read off the guest rather than restated here: the port is a rendered value, and
# a copy of it in the harness is a copy that can disagree with the image.
port=$(ssh "sed -n 's/^ *port: //p' /etc/unbound/conf.d/keel.conf")
[ -n "${port}" ] || { echo "FAIL: no port in the rendered unbound config"; exit 1; }
ports=$(ssh "sudo semanage port -l | grep '^dns_port_t'")
case "${ports}" in
    *"${port}"*) echo "  ${mode}, and ${port} is dns_port_t" ;;
    *)
        echo "FAIL: ${port} carries no dns_port_t label"
        printf '%s\n' "${ports}"
        exit 1
        ;;
esac
unbound_state=$(settled unbound.service)
[ "${unbound_state}" = active ] || {
    echo "FAIL: unbound.service is '${unbound_state:-unknown}' — a required unit, so this rolls back"
    ssh sudo journalctl -u unbound.service -n 30 --no-pager || true
    ssh sudo ausearch -m avc -ts boot 2>/dev/null || true
    exit 1
}
echo "  unbound.service: ${unbound_state}"

# Waited for, not sampled. The check itself waits for the units it judges, so on
# a boot where a container is still starting greenboot is legitimately
# `activating` — and treating that as failure is the same mistake the selftest
# was fixed for.
echo "== greenboot reached a verdict"
verdict=""
for _ in $(seq 1 90); do
    verdict=$(ssh systemctl is-active greenboot-healthcheck.service 2>/dev/null || true)
    case "${verdict}" in
        active | failed) break ;;
    esac
    sleep 2
done
[ "${verdict}" = active ] || {
    echo "FAIL: greenboot ended '${verdict:-unknown}' — on hardware this rolls the image back"
    ssh journalctl -u greenboot-healthcheck --no-pager -n 40 || true
    exit 1
}
ssh systemctl is-active boot-complete.target >/dev/null && echo "  boot-complete.target reached"

echo "== selftest, on a real kernel"
ssh sudo /usr/lib/keel/selftest

# A failure here is a failure on a live system, where the interesting evidence is
# in the journal and dies with the guest. Print it before anything tears down.
dump_guest() {
    echo "-- boot mounts"
    ssh findmnt -no SOURCE,TARGET,FSTYPE,OPTIONS --target /boot/efi || true
    echo "-- selinux denials, enforced only"
    ssh sudo journalctl -b -t audit -g "permissive=0" -n 10 --no-pager || true
    # pihole is Pulumi's to deploy, not the image's, so it exists on this guest
    # only when --pulumi ran.
    if [ -n "${with_pulumi}" ]; then
        echo "-- pihole"
        ssh systemctl status pihole.service --no-pager -n 5 || true
        ssh sudo journalctl -u pihole.service -n 60 --no-pager || true
    fi
    echo "-- failed units"
    ssh systemctl list-units --state=failed --no-legend --plain || true
    for unit in $(ssh systemctl list-units --state=failed --no-legend --plain | awk '{print $1}'); do
        echo "-- journal: ${unit}"
        ssh sudo journalctl -u "${unit}" -n 25 --no-pager || true
    done
}

echo "== selftest, advisory"
ssh sudo /usr/lib/keel/selftest --advisory || true
# Hard, unlike the rest of the advisory block: a unit that failed on a real boot
# is a defect whatever it was, and on a card the evidence is gone by the time it
# is noticed.
if [ -n "$(ssh systemctl list-units --state=failed --no-legend --plain)" ]; then
    dump_guest
    echo "FAIL: units failed on a real boot"
    exit 1
fi

# The recorder is driven by a clock, so what is asserted is the timer being armed
# and the run it eventually triggers — not an ordering that would tie the record
# of a bad boot to the boot going well.
echo "== the flight recorder is on a timer, not on boot success"
timer_state=$(ssh systemctl is-active keel-flightrecorder.timer 2>/dev/null || true)
[ "${timer_state}" = active ] || {
    echo "FAIL: keel-flightrecorder.timer is '${timer_state:-unknown}'"
    ssh systemctl status keel-flightrecorder.timer --no-pager || true
    exit 1
}
echo "  timer: ${timer_state}, $(ssh systemctl show -p TimersMonotonic --value keel-flightrecorder.timer)"

# OnBootSec is two minutes, and what follows it is the run itself: two selftest
# invocations, each waiting on the units it judges, which under emulation is
# minutes rather than seconds. The wait covers both.
echo "  waiting for the timer to have fired"
recorder=""
for _ in $(seq 1 180); do
    recorder=$(ssh systemctl is-active keel-flightrecorder.service 2>/dev/null || true)
    case "${recorder}" in
        active | failed) break ;;
    esac
    sleep 2
done
[ "${recorder}" = active ] || {
    echo "FAIL: keel-flightrecorder.service ended '${recorder:-never triggered}'"
    ssh sudo journalctl -u keel-flightrecorder.service -n 40 --no-pager || true
    exit 1
}
echo "  service: ${recorder}, triggered without multi-user.target ordering"

# The whole point of the recorder is a card that can be read in a laptop, so
# assert the artefact, not just that the unit went green.
echo "== the flight recorder left a readable log on the ESP"
lines=$(ssh sudo wc -l /boot/efi/keel-boot.log 2>/dev/null | awk '{print $1}')
[ "${lines:-0}" -gt 20 ] || { echo "FAIL: keel-boot.log is ${lines:-0} lines"; exit 1; }
for section in "=== bootc status" "=== failed units" "=== greenboot" "=== selftest" \
    "=== journal, this boot, warnings and above"; do
    ssh "sudo grep -q '${section}' /boot/efi/keel-boot.log" || {
        echo "FAIL: log has no '${section}' section"; exit 1; }
done
echo "  ${lines} lines, with the expected sections"

# This layout mounts the ESP rw, so the recorder's remount path does not fire
# here; what is checkable either way is that it left nothing of its own behind.
ssh sudo test ! -e /boot/efi/.keel-writable || {
    echo "FAIL: recorder left its write probe on the ESP"; exit 1; }
echo "  ESP carries only the log"

# Services declare credentials, read from 1Password at deploy time. No
# probe-and-skip: a biometric unlock expires between runs, so probing flakes, and
# a run that skips the deploy and still passes is worse than one that fails.
if [ "${with_pulumi}" = "--pulumi" ]; then
    echo "== deploying the configuration layer to the guest"

    # An identity for the guest. Pulumi seals secrets to its public half; the
    # private half never leaves the machine it belongs to.
    age-keygen -o "${work}/age.key" 2>"${work}/age.pub.txt"
    recipient=$(awk '/Public key:/ { print $NF }' "${work}/age.pub.txt")
    ssh sudo install -D -m 600 /dev/stdin /etc/keel/age.key < "${work}/age.key"

    # PULUMI_BACKEND_URL overrides the repo's own Pulumi.yaml, whose backend.url
    # points at the real state/ — exactly what a throwaway guest deploy does not
    # want, so this run's state lands in its own temp directory instead.
    export PULUMI_BACKEND_URL="file://${work}/state"
    export PULUMI_CONFIG_PASSPHRASE="qemu-trial-only"
    export PULUMI_SKIP_UPDATE_CHECK=true
    mkdir -p "${work}/state"

    stack="${pulumi_host}"
    cd "${repo}"
    pulumi stack init "${stack}" >/dev/null 2>&1 || pulumi stack select "${stack}"

    # sshTarget is what keeps this off the real machine: the stack is named for a
    # host, and without an explicit target the program would deploy to it.
    pulumi config set sshTarget keel-qemu >/dev/null
    pulumi config set sshConfig "${work}/ssh_config" >/dev/null
    pulumi config set ageRecipient "${recipient}" >/dev/null
    # Nothing selects a subset: the host's services list is the whole selector,
    # and the order the services come up in is the graph the catalog declares. So
    # this is the real bring-up of ${stack}, aimed at a throwaway guest.
    echo "  deploying every service ${stack} runs"

    pulumi up --yes --non-interactive --diff || { dump_guest; exit 1; }

    echo "== the deployed resolver answers"
    ssh systemctl is-active --quiet pihole.service || {
        echo "FAIL: pihole did not come up"
        ssh sudo journalctl -u pihole -n 30 --no-pager || true
        exit 1
    }
    # Pi-hole answers as soon as its own health check passes, but the first
    # recursive query also waits on Unbound priming from the root hints, which
    # under emulation is not instant. The contract is that it resolves, not that
    # it resolves before Unbound has ever spoken to a root server.
    answer=""
    deadline=$(( $(date +%s) + 90 ))
    while [ "$(date +%s)" -lt "${deadline}" ]; do
        answer=$(ssh "dig +short +time=5 +tries=1 @127.0.0.1 example.com A | head -1")
        [ -n "${answer}" ] && break
        sleep 3
    done
    [ -n "${answer}" ] || {
        echo "FAIL: no answer from the deployed resolver after 90s"
        ssh sudo journalctl -u unbound -n 20 --no-pager || true
        dump_guest
        exit 1
    }
    echo "  pihole up, example.com -> ${answer}"

    # Drift, which is the entire reason these providers implement `read`. Both
    # are done behind Pulumi's back, the way a person at a console does them.
    echo "== drift on the machine is seen and undone"
    ssh sudo systemctl stop pihole.service
    ssh "echo broken | sudo tee -a /etc/traefik/dynamic/pihole.yaml >/dev/null"

    pulumi refresh --yes --non-interactive >/dev/null
    pulumi up --yes --non-interactive >/dev/null

    ssh systemctl is-active --quiet pihole.service || {
        echo "FAIL: a stopped service was not restarted"; dump_guest; exit 1; }
    ssh "sudo grep -q broken /etc/traefik/dynamic/pihole.yaml" && {
        echo "FAIL: a hand-edited file was not rewritten"; exit 1; }
    echo "  stopped service restarted, edited file rewritten"

    pulumi destroy --yes --non-interactive >/dev/null
    pulumi stack rm "${stack}" --yes >/dev/null
fi

echo "== shutting down"
ssh sudo poweroff 2>/dev/null || true
for _ in $(seq 1 30); do
    kill -0 "${QEMU_PID}" 2>/dev/null || break
    sleep 2
done

echo "all QEMU boot checks passed"
