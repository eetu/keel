#!/usr/bin/env bash
# Turn a built disk image into a card ready to flash: shrink the root
# filesystem, rebuild the ESP as FAT32, and inject the Pi boot chain plus an
# optional keel.conf — as one privileged container run.
#
#   image/finalize-card.sh build/card/image/disk.raw keel:latest build/card/keel.conf
#
# Four things happen in an order that matters, all inside a single fedora:43
# container so the union toolset (e2fsprogs, dosfstools, jq, util-linux,
# rsync) is installed once and the ESP and root partitions are each located
# once:
#
#   1. Shrink the root filesystem and bring the partition table in to match,
#      the way `keel-growfs` on first boot lets it grow back out to whatever
#      card it landed on.
#   2. Reformat the ESP as FAT32 — bootc-image-builder's ~500 MB ESP is
#      FAT16, which draws recurring "FAT volume not supported" reports from
#      the Pi 4's EEPROM bootloader — preserving its volume label and its
#      volume ID. The ID matters: bootc-image-builder bakes the ESP's UUID
#      into a static `boot-efi.mount` unit inside the image it ships, and a
#      reformat that hands out a fresh random one orphans that unit for the
#      life of the card.
#   3. Lift the Pi boot chain (U-Boot, firmware, DTBs) out of the image
#      itself, so the boot chain is a property of the image and a card built
#      from it cannot disagree with it.
#   4. Sideload keel.conf, if given — the file that turns the generic image
#      into a particular host.
set -euo pipefail

disk="${1:?usage: image/finalize-card.sh <disk.raw> <image-tag> [keel.conf]}"
tag="${2:?usage: image/finalize-card.sh <disk.raw> <image-tag> [keel.conf]}"
keel_conf="${3:-${KEEL_CONF_SRC:-}}"

[ -f "${disk}" ] || { echo "FAIL: no such image: ${disk}"; exit 1; }
if [ -n "${keel_conf}" ]; then
    [ -f "${keel_conf}" ] || { echo "FAIL: no such keel.conf: ${keel_conf}"; exit 1; }
fi

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=image/lib.sh
source "${here}/lib.sh"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
basename "${disk}" > "${work}/diskname"
if [ -n "${keel_conf}" ]; then
    cp "${keel_conf}" "${work}/keel.conf"
fi

echo "== lifting the Pi boot chain out of ${tag}"
podman run --rm "${tag}" tar -C /usr/lib/keel/rpi -cf - . > "${work}/rpi.tar"
tar -tf "${work}/rpi.tar" | sed 's/^/  /'

# Each [pi*] section scopes the kernel line to the model it is for — same
# target on every board, since it is the one U-Boot binary that covers all
# three. arm_64bit=1 is what makes Pi 3's 32-bit-by-default firmware start the
# ARM core in AArch64; on 4 and 5 it is already the default and the line is a
# no-op. enable_uart gives a serial console on GPIO 14/15, the only witness to
# a failure that happens before Linux can write anything down.
#
# No device_tree= lines: the dtb names staged onto the ESP are the firmware's
# own defaults, so each board's firmware finds its dtb without being told. On a
# 5 that firmware is the SPI EEPROM, off the card entirely — it reads this same
# config.txt and loads kernel= itself, which is the only reason a 5 needs
# nothing here beyond its dtb sitting at the ESP root.
cat > "${work}/config.txt" <<'EOF'
# Written by keel. The Pi's ROM (or, on a 5, its SPI EEPROM) reads this before
# anything else exists.
[pi3]
kernel=rpi-u-boot.bin
[pi4]
kernel=rpi-u-boot.bin
[pi5]
kernel=rpi-u-boot.bin
[all]
arm_64bit=1
enable_uart=1
uart_2ndstage=1
EOF

cat > "${work}/finalize.sh" <<'INNER'
set -eu
dnf -y install --quiet e2fsprogs dosfstools jq util-linux rsync >/dev/null
. /lib.sh

disk="/image/$(cat /w/diskname)"

# --- shrink the root filesystem -----------------------------------------
# Four steps, in an order that matters: shrink the filesystem, bring the
# partition end in to match, truncate the file, then rewrite the table.
# Doing the truncate before the rewrite would put the GPT's backup header,
# which sfdisk places at the end of the disk as it finds it, in the region
# about to be discarded — after which the disk has only a protective MBR and
# reads as `dos`.
read -r rstart rsize rnode <<EOF
$(root_partition_offset "$disk")
EOF
echo "  root is $rnode at sector $rstart, $rsize sectors"

rloop=$(losetup --find --show --offset $((rstart * 512)) --sizelimit $((rsize * 512)) "$disk")
trap 'losetup -d "$rloop" 2>/dev/null || true' EXIT

# `-p` first (fixes what it safely can); `-y` only if that was not enough. A
# `-y` that still cannot repair the filesystem is unrecoverable corruption,
# not a transient error, so it aborts here rather than resizing and shipping
# a card built on a filesystem e2fsck gave up on.
if ! e2fsck -f -p "$rloop" >/dev/null 2>&1; then
    if ! e2fsck -f -y "$rloop" >/dev/null 2>&1; then
        echo "FAIL: e2fsck could not repair the root filesystem"
        exit 1
    fi
fi
resize2fs -M "$rloop" >/dev/null 2>&1

block_count=$(dumpe2fs -h "$rloop" 2>/dev/null | awk -F: '/Block count/ { print $2 }' | tr -d ' ')
block_size=$(dumpe2fs -h "$rloop" 2>/dev/null | awk -F: '/Block size/ { print $2 }' | tr -d ' ')
losetup -d "$rloop"
trap - EXIT

# Some slack so the filesystem is not left with zero free blocks, and so the
# partition ends on a round boundary.
fs_sectors=$(( block_count * block_size / 512 ))
new_size=$(( fs_sectors + 32768 ))
new_size=$(( (new_size + 2047) / 2048 * 2048 ))
echo "  filesystem shrunk to $fs_sectors sectors; partition set to $new_size"

if [ "$new_size" -lt "$rsize" ]; then
    # The dump carries every partition's type and UUID, so rewriting it this
    # way keeps both: a regenerated PARTUUID would leave the bootloader
    # pointing at nothing. Matched on the exact node string from the table
    # rather than a pattern, because a pattern that quietly fails to match
    # would write the original table back.
    sfdisk -d "$disk" > /w/table.orig
    awk -v node="$rnode" -v newsize="$new_size" '
        $1 == node { sub(/size=[ ]*[0-9]+/, "size=" newsize) }
        { print }' /w/table.orig > /w/table.new
    grep -q "size= *${new_size}" /w/table.new || {
        echo "FAIL: did not find $rnode in the table, so nothing was resized"
        exit 1
    }
    # 34 sectors is the GPT backup header plus its partition array.
    truncate -s $(( (rstart + new_size + 34) * 512 )) "$disk"
    sfdisk --no-reread --no-tell-kernel --force "$disk" < /w/table.new >/dev/null

    gpt_label=$(sfdisk --json "$disk" 2>/dev/null | jq -r ".partitiontable.label")
    [ "$gpt_label" = "gpt" ] || { echo "FAIL: table reads as '$gpt_label' after shrinking"; exit 1; }
    parts=$(sfdisk --json "$disk" 2>/dev/null | jq -r ".partitiontable.partitions | length")
    [ "$parts" -ge 3 ] || { echo "FAIL: only $parts partitions survived"; exit 1; }
    echo "  table still GPT with $parts partitions"
else
    echo "  already smaller than the layout; nothing to reclaim"
fi

# --- reformat the ESP as FAT32 ------------------------------------------
read -r estart esize <<EOF
$(esp_partition_offset "$disk")
EOF
[ -n "$estart" ] || { echo "FAIL: no EFI System partition in the image"; exit 1; }

eloop=$(losetup --find --show --offset $((estart * 512)) --sizelimit $((esize * 512)) "$disk")
trap 'losetup -d "$eloop" 2>/dev/null || true' EXIT

# Both read before the reformat destroys them. blkid exits 0 with empty
# output when a tag is absent, so an `-n` test is what actually catches
# that — `blkid ... || echo fallback` never fires.
esp_uuid=$(blkid -o value -s UUID "$eloop" 2>/dev/null || true)
esp_label=$(blkid -o value -s LABEL "$eloop" 2>/dev/null || true)
[ -n "$esp_label" ] || esp_label="EFI-SYSTEM"

mkdir -p /mnt/esp /w/contents
mount "$eloop" /mnt/esp
rsync -a /mnt/esp/ /w/contents/
umount /mnt/esp

# -F 32 needs enough clusters to be a legal FAT32; a 500 MB partition at 4 KB
# clusters has ~128k of them, comfortably past the 65525 floor. -i restores
# the volume ID the partition already had — see the header comment on why
# that id, not just the label, has to survive the reformat.
if [ -n "$esp_uuid" ]; then
    mkfs.vfat -F 32 -n "$esp_label" -i "${esp_uuid//-/}" "$eloop" >/dev/null
else
    mkfs.vfat -F 32 -n "$esp_label" "$eloop" >/dev/null
fi

mount "$eloop" /mnt/esp
rsync -a /w/contents/ /mnt/esp/

# --- inject the Pi boot chain, config.txt and keel.conf -----------------
tar -C /mnt/esp -xf /w/rpi.tar
cp /w/config.txt /mnt/esp/config.txt

# The one file that names this board. Absent means a bare image — still
# bootable, and still writable on this ESP from any laptop later, just not yet
# anyone's host and with no account to reach it as.
if [ -f /w/keel.conf ]; then
    cp /w/keel.conf /mnt/esp/keel.conf
fi

# A card missing any of these powers on and sits there, with nothing to say
# why. Grouped per board: the shared files plus each of the 3 and 4 sets are
# fatal, because those are the boards this card supports. The Pi 5 dtb is
# checked separately, below, as a warning rather than a failure — no Pi 5 has
# booted this yet, so nothing here can promise the file is sufficient, only
# that it is present.
shared="config.txt rpi-u-boot.bin"
pi3="bootcode.bin start.elf fixup.dat bcm2710-rpi-3-b.dtb bcm2710-rpi-3-b-plus.dtb"
pi4="start4.elf fixup4.dat bcm2711-rpi-4-b.dtb"
for required in $shared $pi3 $pi4; do
    [ -f "/mnt/esp/$required" ] || { echo "FAIL: $required missing from the ESP"; exit 1; }
done
for best_effort in bcm2712-rpi-5-b.dtb bcm2712d0-rpi-5-b.dtb; do
    [ -f "/mnt/esp/$best_effort" ] || echo "WARN: $best_effort missing from the ESP (Pi 5 boot is best-effort)"
done

# GRUB has to be where U-Boot's EFI loader looks, which is the removable path.
[ -f /mnt/esp/EFI/BOOT/BOOTAA64.EFI ] || { echo "FAIL: no EFI/BOOT/BOOTAA64.EFI"; exit 1; }

sync
echo "  ESP now carries:"
ls /mnt/esp | sed 's/^/    /'
umount /mnt/esp
losetup -d "$eloop"
trap - EXIT
INNER

before=$(file_size_bytes "${disk}")
echo "== finalizing $(basename "${disk}")"
podman run --rm --privileged \
    --volume "$(cd "$(dirname "${disk}")" && pwd):/image" \
    --volume "${work}:/w" \
    --volume "${here}/lib.sh:/lib.sh:ro" \
    quay.io/fedora/fedora:43 bash /w/finalize.sh
after=$(file_size_bytes "${disk}")
printf '  %s GB -> %s GB apparent\n' \
    "$(( before / 1024 / 1024 / 1024 ))" "$(( after / 1024 / 1024 / 1024 ))"
