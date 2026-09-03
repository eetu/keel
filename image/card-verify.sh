#!/usr/bin/env bash
# Boot the finished card image, exactly as built, and watch the console.
#
#   image/card-verify.sh build/card/image/disk.raw [keel.conf]
#
# The last gate before a flash. qemu-test.sh proves the *image* boots; this proves
# the artefact does, after shrinking and after the ESP was rewritten — the two
# steps most able to produce a file that looks finished and is not.
#
# No ssh here: the card carries the real admin key, whose private half is not on
# this machine. The console is the only witness, and it is enough — provided what
# is asserted on it is something that can actually appear there. Two things can:
# kernel printk, and the login banner. Every assertion below is one of those. A
# unit status line is not: systemd stops mirroring those to the console the moment
# journald takes over, about two seconds in, so no userspace unit can ever be seen
# here and an assertion that greps for one passes or fails for the wrong reason.
#
# Given the keel.conf the card was built with, the banner check becomes the real
# end-to-end one: the name in that file is the name the getty prints only if the
# ESP was mounted, read, and applied.
#
# Work happens on a copy, grown to look like a larger card. The original is left
# byte-identical for Etcher.
set -euo pipefail

disk="${1:?usage: image/card-verify.sh <disk.raw> [keel.conf]}"
[ -f "${disk}" ] || { echo "FAIL: no such image: ${disk}"; exit 1; }

# The hostname the card should come up as. Absent means a card built with no
# identity, where "fedora" is the correct answer and there is nothing to assert.
keel_conf="${2:-}"
expect_host=""
if [ -n "${keel_conf}" ]; then
    [ -f "${keel_conf}" ] || { echo "FAIL: no such keel.conf: ${keel_conf}"; exit 1; }
    expect_host=$(sed -n 's/^KEEL_HOSTNAME=\([A-Za-z0-9-]*\).*/\1/p' "${keel_conf}" | head -1)
fi

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=image/lib.sh
source "${here}/lib.sh"

deadline_secs="${KEEL_CARD_BOOT_TIMEOUT:-240}"

work="$(mktemp -d)"
QEMU_PID=""
cleanup() {
    if [ -n "${QEMU_PID}" ]; then kill "${QEMU_PID}" 2>/dev/null || true; fi
    rm -rf "${work}"
}
trap cleanup EXIT

echo "== copying the card image (the original stays untouched)"
cp "${disk}" "${work}/card.raw"
qemu-img resize -f raw "${work}/card.raw" 16G >/dev/null
cp "${QEMU_FIRMWARE}/edk2-arm-vars.fd" "${work}/vars.fd"

echo "== booting it"
boot_disk_under_qemu "${work}/card.raw" "${work}/vars.fd" "${work}/console.log" \
    -machine virt,accel=hvf -cpu host \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0

# A login prompt is the completion signal: it means GRUB found a kernel, the
# initramfs found the root, and systemd reached multi-user.
if ! wait_for_console "${work}/console.log" "login:" "${deadline_secs}"; then
    echo "FAIL: no login prompt within ${deadline_secs}s (or QEMU exited early)"
    tail -40 "${work}/console.log" || true
    exit 1
fi
echo "  reached a login prompt"

# Shrinking the image is only safe because this runs on the real card, so it is
# worth asserting on the real artefact rather than trusting the earlier tier.
if grep -q "resizing filesystem" "${work}/console.log"; then
    echo "  keel-growfs claimed the rest of the disk: $(
        grep -o 'resizing filesystem from [0-9]* to [0-9]* blocks' "${work}/console.log" | tail -1)"
else
    echo "FAIL: keel-growfs did not grow the root filesystem"
    grep -i "growfs\|resize" "${work}/console.log" | tail -20 || true
    exit 1
fi

# keel-firstboot says everything twice, and the second copy goes to /dev/kmsg
# precisely so it lands here. `keel-firstboot:` is its prefix, so a match is the
# script's own voice rather than an inference from something near it.
if grep -q "keel-firstboot:" "${work}/console.log"; then
    echo "  keel-firstboot ran:"
    grep -o "keel-firstboot: .*" "${work}/console.log" | sed 's/^/    /'
else
    echo "FAIL: keel-firstboot said nothing on the console"
    grep -i "firstboot" "${work}/console.log" | tail -20 || true
    exit 1
fi

# The end of the chain. Reaching this name means the ESP was mounted, keel.conf
# was readable from the domain the unit runs in, and the hostname was applied
# before getty printed its banner — the whole point of a generic image, asserted
# on the one artefact that ships.
if [ -n "${expect_host}" ]; then
    if grep -q "${expect_host} login:" "${work}/console.log"; then
        echo "  the card came up as ${expect_host}"
    else
        echo "FAIL: banner is not '${expect_host} login:' — keel.conf was not applied"
        grep -o "[A-Za-z0-9.-]* login:" "${work}/console.log" | tail -5 || true
        exit 1
    fi
fi

# Never fatal, and never evidence of the absence of failures either: a unit that
# fails after journald starts says so only in the journal, so a quiet run here
# means the console was quiet, not that the boot was clean. Printed anyway,
# because the handful of failures early enough to land on the console are worth
# seeing before the card leaves the machine. Judging the whole unit list needs a
# shell on the guest, which is image/qemu-test.sh.
if grep -qi "failed to start\|dependency failed" "${work}/console.log"; then
    echo "  units that failed early enough to reach the console:"
    grep -i "failed to start\|dependency failed" "${work}/console.log" | sed 's/^/    /' | sort -u
fi

echo "card image boots"
