#!/usr/bin/env bash
# Smoke tests against a built image.
#
#   image/test.sh [tag]
#
# Two phases, both without a VM. A bootc image is an ordinary OCI image, so the
# static phase runs in a plain container; the boot phase runs the image's own
# systemd under podman and asserts the units actually come up.
#
# What this catches that the render tests cannot: unit files systemd rejects,
# missing packages, a service that crashes on start after a version bump, and a
# memory generator that picks the wrong profile. What it cannot catch is anything
# CPU- or kernel-specific — for that see the QEMU boot test, which is the only
# thing on a development machine that runs the board's actual instruction set.
set -euo pipefail

tag="${1:-keel:latest}"
run() { podman run --rm --arch arm64 "$@"; }

echo "== bootc lint"
run "${tag}" bootc container lint --fatal-warnings

echo "== systemd unit syntax"
run "${tag}" sh -c 'systemd-analyze verify /usr/lib/systemd/system/keel-*'

# NET_ADMIN because `nft --check` has no pure-syntax mode — it validates the
# ruleset against the running kernel, so without the capability it cannot run at
# all ("cache initialization failed") rather than reporting the ruleset bad.
echo "== selftest, static"
run --cap-add NET_ADMIN "${tag}" /usr/lib/keel/selftest --static

# `systemctl preset-all` only creates symlinks for units not already enabled, so
# a silent no-op and a correctly-inherited default look identical in build output.
# This asserts the end state instead of the transition.
echo "== every presetted unit is enabled"
run "${tag}" sh -c '
    units=$(sed -n "s/^enable //p" /usr/lib/systemd/system-preset/50-keel.preset)
    rc=0
    for unit in $units; do
        state=$(SYSTEMD_OFFLINE=1 systemctl is-enabled "$unit" 2>&1 || true)
        case "$state" in
            enabled|enabled-runtime|static|indirect)
                printf "  %s: %s\n" "$unit" "$state"
                continue
                ;;
        esac
        # A quadlet-backed unit does not exist until daemon-reload runs the
        # generator, and nothing is running here. Its source file is the evidence
        # that it will exist, and the booted tiers check that it actually does.
        quadlet="/usr/share/containers/systemd/${unit%.service}.container"
        if [ "$state" = "not-found" ] && [ -f "$quadlet" ]; then
            printf "  %s: from a quadlet, checked when booted\n" "$unit"
            continue
        fi
        printf "  %s: FAIL (%s)\n" "$unit" "$state"
        rc=1
    done
    exit $rc
'

echo "== memory generator picks each profile"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
for profile in 1g 4g 8g; do
    printf 'console=tty1 keel.mem_profile=%s\n' "${profile}" > "${tmp}/cmdline"
    got=$(run --volume "${tmp}/cmdline:/proc/cmdline:ro" "${tag}" sh -c '
        out=$(mktemp -d)
        /usr/lib/systemd/system-generators/keel-memory-generator "$out" "" ""
        link=$(find "$out" -name 50-keel-memory.conf | head -1)
        if [ -n "$link" ]; then readlink "$link"; fi
    ' || true)
    case "${got}" in
        */"${profile}"/units/*) echo "  ${profile}: ok" ;;
        "") echo "  ${profile}: no drop-ins (expected until services are in the image)" ;;
        *) echo "  ${profile}: FAIL — generator staged ${got}"; exit 1 ;;
    esac
done

esp="${tmp}/esp"
mkdir -p "${esp}"

# A fabricated identity, so the boot phase exercises keel-firstboot's real
# convergence rather than the bare-image path the render tests already cover.
# 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved for exactly this, and
# unmistakable in output as a value nothing on a real network would send.
#
# What the bind mount below cannot test, and what only a real boot can: this is a
# directory on the host's own filesystem, so it carries ordinary labels and the
# ESP's discovery never happens. On a card the same path is a FAT volume mounted
# from a GPT partition, every inode on it is dosfs_t, and a domain that reads a
# file here happily gets EACCES there. Nothing about ESP discovery or ESP access
# is in evidence at this tier — image/card-verify.sh is where that is decided.
ssh-keygen -q -t ed25519 -N '' -f "${tmp}/key"
cat > "${esp}/keel.conf" <<EOF
KEEL_HOSTNAME=testhost
KEEL_ADMIN_KEY=$(cat "${tmp}/key.pub")
KEEL_LAN_CIDR=192.0.2.0/24
EOF

# --- boot phase -------------------------------------------------------------
# The image's own systemd, as pid 1. NET_ADMIN so nftables can actually load its
# table rather than merely parse it.
name="keel-smoke-$$"
cleanup() { podman rm -f "${name}" >/dev/null 2>&1 || true; rm -rf "${tmp}"; }
trap cleanup EXIT

echo "== booting the image under podman"
podman run -d --rm --arch arm64 --name "${name}" \
    --systemd=always --cap-add NET_ADMIN,NET_RAW \
    --volume "${esp}:/boot/efi" \
    "${tag}" /sbin/init >/dev/null

state=""
for _ in $(seq 1 90); do
    state=$(podman exec "${name}" systemctl is-system-running 2>/dev/null || true)
    case "${state}" in
        running | degraded) break ;;
    esac
    sleep 1
done
echo "  system state: ${state:-unknown}"

if [ -z "${state}" ]; then
    echo "  FAIL — systemd never reported a state"
    podman logs "${name}" 2>&1 | tail -30
    exit 1
fi

# nftables.service itself is not asserted live here — a container, even with
# NET_ADMIN, does not reliably load a full table the way a kernel booted by
# QEMU or hardware does, and qemu-test.sh already covers the live ruleset. What
# is checkable here, and is the part keel-firstboot actually owns, is the file
# it wrote for nftables to load.
echo "== keel-firstboot applied the fabricated keel.conf"
hostname=$(podman exec "${name}" cat /etc/hostname)
[ "${hostname}" = testhost ] || { echo "FAIL: hostname is '${hostname}', not testhost"; exit 1; }
echo "  hostname: ${hostname}"

# Both names come out of the image rather than being restated here, so this tier
# cannot pass against a policy that has drifted from the one it is asserting.
admin=$(podman exec "${name}" sed -n 's/^admin=//p' /usr/bin/keel-firstboot)
group=$(podman exec "${name}" sed -n 's/^group=//p' /usr/bin/keel-firstboot)
[ -n "${admin}" ] && [ -n "${group}" ] || {
    echo "FAIL: keel-firstboot names no admin account or no group"
    exit 1
}

podman exec "${name}" id "${admin}" >/dev/null || {
    echo "FAIL: admin user ${admin} was not created"
    exit 1
}
echo "  admin user: ${admin}"

podman exec "${name}" grep -q 192.0.2.0/24 /etc/keel/nft.d/10-ranges.nft || {
    echo "FAIL: 10-ranges.nft does not contain 192.0.2.0/24"
    podman exec "${name}" cat /etc/keel/nft.d/10-ranges.nft || true
    exit 1
}
echo "  10-ranges.nft admits 192.0.2.0/24"

firstboot_state=$(podman exec "${name}" systemctl is-active keel-firstboot.service 2>/dev/null || true)
[ "${firstboot_state}" = active ] || {
    echo "FAIL: keel-firstboot.service is '${firstboot_state}', not active"
    podman exec "${name}" journalctl -u keel-firstboot.service --no-pager || true
    exit 1
}
echo "  keel-firstboot.service: ${firstboot_state}"

# What the rendered bytes cannot show: how sshd and sudo actually read them. The
# image names a group and no account, so a board's login is whoever first-boot
# put in that group — and everything below is asked of the running daemons rather
# than of the config files they were parsed from.
echo "== the running sshd admits a group, and only the group"
effective=$(podman exec "${name}" sshd -T)
printf '%s\n' "${effective}" | grep -qx "allowgroups ${group}" || {
    echo "FAIL: sshd -T does not report 'allowgroups ${group}'"
    printf '%s\n' "${effective}" | grep -E '^(allow|deny)' || true
    exit 1
}
if printf '%s\n' "${effective}" | grep -qE '^(allow|deny)users'; then
    echo "FAIL: sshd still admits or denies accounts by name"
    printf '%s\n' "${effective}" | grep -E '^(allow|deny)users'
    exit 1
fi
echo "  sshd -T: $(printf '%s\n' "${effective}" | grep -x "allowgroups ${group}"), no allowusers"

echo "== the account first-boot created is in that group, and sudo grants it"
groups=$(podman exec "${name}" id -nG "${admin}")
case " ${groups} " in
    *" ${group} "*) echo "  id -nG ${admin}: ${groups}" ;;
    *) echo "FAIL: ${admin} is not in ${group} (groups: ${groups})"; exit 1 ;;
esac

entry=$(podman exec "${name}" getent group "${group}")
case ",${entry##*:}," in
    *",${admin},"*) echo "  getent group ${group}: ${entry}" ;;
    *) echo "FAIL: getent group ${group} does not list ${admin} — '${entry}'"; exit 1 ;;
esac

# The grant is what every device resource depends on: a deploy reaches the host
# as `ssh <alias> sudo …`, so sudo's own view of it is the claim worth asserting.
grant=$(podman exec "${name}" sudo -l -U "${admin}")
printf '%s\n' "${grant}" | grep -q 'NOPASSWD' || {
    echo "FAIL: sudo -l -U ${admin} shows no passwordless grant"
    printf '%s\n' "${grant}"
    exit 1
}
echo "  sudo -l -U ${admin}: $(printf '%s\n' "${grant}" | grep 'NOPASSWD' | tr -s ' ')"

echo "== selftest, booted (required)"
if ! podman exec "${name}" /usr/lib/keel/selftest; then
    echo "--- failed units"
    podman exec "${name}" systemctl list-units --state=failed --no-legend || true
    echo "--- journal tail"
    podman exec "${name}" journalctl -p warning -n 40 --no-pager || true
    exit 1
fi

# Informational by design. A container cannot start systemd-oomd or polkit
# (CAP_SYS_ADMIN), mount rpc_pipefs, or update a bootloader, so a failed-unit
# list here says more about podman than about the image.
echo "== selftest, booted (advisory)"
podman exec "${name}" /usr/lib/keel/selftest --advisory || true

# The failed units above (rpc_pipefs, bootloader-update, polkit, oomd) are
# podman's own limitations, not the image's — real on hardware, noise here.
# Cleared so the checks below see the boot this container actually had, which
# is what "healthy" means for the recorder's own bad-boot detection.
podman exec "${name}" systemctl reset-failed

# Here rather than in a cold container: the recorder runs the selftest, whose unit
# checks wait out their whole deadline when systemd is not pid 1. Twice, to cover
# both the first boot, when there is no log to rotate, and a rotation.
echo "== flight recorder writes a log, on a first boot and on a rotate"
# The timer is what triggers the recorder on a real boot, and this tier can see
# that it is armed. It is then stopped and the ESP cleared, so the two runs below
# are the only writers: a timer elapsing mid-assertion would rotate the log out
# from under the greps that follow.
timer_state=$(podman exec "${name}" systemctl is-active keel-flightrecorder.timer 2>/dev/null || true)
[ "${timer_state}" = active ] || {
    echo "  FAIL — keel-flightrecorder.timer is '${timer_state:-unknown}'"
    exit 1
}
podman exec "${name}" systemctl stop keel-flightrecorder.timer
podman exec "${name}" rm -f /boot/efi/keel-boot.log /boot/efi/keel-boot.prev.log
for pass in first rotate; do
    podman exec "${name}" /usr/bin/keel-flightrecorder
    [ -s "${esp}/keel-boot.log" ] || { echo "  ${pass}: FAIL — no log written"; exit 1; }
    echo "  ${pass}: ok"
done
[ -s "${esp}/keel-boot.prev.log" ] || { echo "  FAIL — rotate kept no previous log"; exit 1; }
grep -q "=== bootc status" "${esp}/keel-boot.log" || { echo "  FAIL — log has no bootc section"; exit 1; }
grep -q "=== selftest" "${esp}/keel-boot.log" || { echo "  FAIL — log has no selftest section"; exit 1; }
grep -q "=== journal, this boot, warnings and above" "${esp}/keel-boot.log" || {
    echo "  FAIL — log has no warnings section"; exit 1; }
if grep -q "=== journal, this boot, everything" "${esp}/keel-boot.log"; then
    echo "  FAIL — a healthy boot wrote the full journal"
    exit 1
fi
[ ! -e "${esp}/.keel-writable" ] || { echo "  FAIL — write probe left behind"; exit 1; }
echo "  previous boot kept, summary present, no full journal on a healthy boot"

# The one case the full journal earns its place: force a bad boot cheaply, by
# stopping a required unit, which fails the recorder's own selftest run.
echo "== flight recorder appends the full journal on a bad boot"
podman exec "${name}" systemctl stop unbound.service
podman exec "${name}" /usr/bin/keel-flightrecorder
grep -q "=== journal, this boot, everything" "${esp}/keel-boot.log" || {
    echo "  FAIL — a bad boot did not write the full journal"
    exit 1
}
echo "  full journal present"

echo "all image checks passed"
