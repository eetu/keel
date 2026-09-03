#!/usr/bin/env bash
# Produce a card image ready to flash.
#
#   image/card.sh raspi
#
# Builds the one generic image, turns it into a disk image, makes the disk
# bootable on a Raspberry Pi 3B/3B+ or 4 (best-effort on a 5, hardware
# untested), and sideloads the host's identity onto the ESP as keel.conf. The
# result is a raw file for Etcher.
#
# Distinct from qemu-test.sh, which builds a throwaway disk with a throwaway
# key. This one carries the host's real admin keys, because the whole point is
# that the board answers `ssh raspi` on first boot.
set -euo pipefail

host="${1:?usage: image/card.sh <host> [tag]}"
tag="${2:-keel:latest}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "${here}")"
out="${repo}/build/card"

# shellcheck source=image/lib.sh
source "${here}/lib.sh"

cd "${repo}"

echo "== building ${tag}"
image/build.sh "${tag}"
echo "  built"

# The image's own checks, before any of it reaches a card. They include
# `nft --check`, and a ruleset that does not load leaves a default-drop box with
# no firewall and greenboot rebooting it.
echo "== image checks"
image/test.sh "${tag}" >/dev/null
echo "  passed"

mkdir -p "${out}"
yarn card-config "${host}" > "${out}/keel.conf"
echo "== keel.conf for ${host}"
sed 's/^/  /' "${out}/keel.conf"

# A previous run's disk would otherwise be found by the firmware step below.
rm -rf "${out}/image"

echo "== building the disk image"
run_bib "${tag}" "${out}"

disk=$(find "${out}" -name '*.raw' | head -1)
[ -n "${disk}" ] || { echo "FAIL: no raw disk produced"; exit 1; }

image/finalize-card.sh "${disk}" "${tag}" "${out}/keel.conf"

# The artefact itself, after shrinking and after the ESP was rewritten — the two
# steps most able to produce a file that looks finished and does not boot. The
# keel.conf goes with it so the boot can be judged against the identity the card
# was actually given, rather than against merely reaching a login prompt.
image/card-verify.sh "${disk}" "${out}/keel.conf"

# Etcher picks images by extension, and bootc-image-builder always names its
# output `disk.raw` — which says nothing about which host it is for. A hard link
# costs no space and gives the file both a recognised suffix and a name worth
# reading in a file picker.
card="$(dirname "${disk}")/keel-${host}.img"
rm -f "${card}"
ln "${disk}" "${card}"

cat <<EOF

Card image ready:
  ${card}   ($(du -h "${disk}" | cut -f1) on disk, $(( $(file_size_bytes "${disk}") / 1024 / 1024 / 1024 )) GB apparent)

Flash it, then on first boot attach a monitor if you can — or a 3.3 V serial
adapter on GPIO 14/15, which config.txt enables and which is the only witness to
a failure that happens before Linux starts.

The image is shrunk to roughly its contents, because Etcher writes every block
and flashing is the slow step. keel-growfs claims the rest of the card on first
boot, so a 120 GB card still ends up with a 120 GB root.

If it does not come up, put the card back in this machine and read
keel-boot.log on the FAT partition — it mounts on any laptop, and carries the
journal, the failed units and the selftest output. keel-boot.prev.log is the boot
before, which is the one that matters if the board is looping.
EOF
