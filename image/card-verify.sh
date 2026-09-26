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
#
# Measured on the disk, never grepped off the console. This used to look for
# "resizing filesystem from N to M blocks", which nothing emits: the chain is
# bootc-generic-growpart -> growpart -> systemd-growfs, and systemd-growfs says
# `Successfully resized "%s" to %s bytes` — to the journal, which is not
# mirrored to the console this late in the boot. So the check failed on every
# card, including the ones that grew perfectly, and the header's own warning
# about assertions that "pass or fail for the wrong reason" was describing it.
#
# The partition is the evidence, and it outlives the boot: growpart rewrites the
# table on the disk qemu just booted, so comparing partition 3's end against the
# disk is the fact the console could only ever have gossiped about.
#
# Through a container because `root_partition_offset` is sfdisk and jq, and this
# script runs on the host — the same reason finalize-card.sh does its own work
# that way. The helper is sourced rather than reimplemented, so there is one
# reader of a partition table in this repository and not two.
grown_sectors=$(podman run --rm \
    --volume "${work}:/w:ro" --volume "${here}/lib.sh:/lib.sh:ro" \
    quay.io/fedora/fedora:43 sh -c \
    'dnf install -y --quiet util-linux jq >/dev/null 2>&1; . /lib.sh
     root_partition_offset /w/card.raw' | awk '{ print $2 }')
disk_sectors=$(( $(file_size_bytes "${work}/card.raw") / 512 ))
# Claimed means "ends within a megabyte of the disk", which is where growpart
# leaves it: the GPT backup header lives in those last sectors.
if [ "${grown_sectors}" -gt $(( disk_sectors - 2048 - 3125248 )) ]; then
    echo "  keel-growfs claimed the rest of the disk: root is now ${grown_sectors} sectors"
else
    echo "FAIL: keel-growfs did not grow the root filesystem"
    echo "      root is ${grown_sectors} sectors on a disk of ${disk_sectors}"
    exit 1
fi

# growpart rewrote the partition table to do that, and a rewrite that puts back
# a plain protective MBR leaves a card a Pi 3 boots exactly once: the ROM finds
# the ESP on first power-on, and on every one after it finds nothing. So the
# hybrid entries finalize-card.sh wrote are checked on the disk as it stands
# after the boot, not as it was flashed.
mbr_types=$(dd if="${work}/card.raw" bs=1 skip=446 count=64 2>/dev/null | od -An -tx1 -v |
    tr -s ' \n' ' ' | awk '{ print $5, $21 }')
if [ "${mbr_types}" = "0c ee" ]; then
    echo "  hybrid MBR survived the first boot's growpart"
else
    echo "FAIL: MBR entries read '${mbr_types}' after first boot — a Pi 3 would not boot again"
    exit 1
fi

# keel-firstboot copies every line to /dev/kmsg for a serial console to read,
# and on a Pi it gets one: the cmdline's console=ttyS0 is the mini-UART on GPIO
# 14/15. qemu's virt machine has no ttyS0 — its serial is ttyAMA0, where only
# the getty answers — so no printk line of any level reaches this log, and a
# check that demanded one failed every card. Printed when present; what proves
# firstboot ran is the banner below, which only keel.conf can have named.
if grep -q "keel-firstboot:" "${work}/console.log"; then
    echo "  keel-firstboot said:"
    grep -o "keel-firstboot: .*" "${work}/console.log" | sed 's/^/    /'
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
