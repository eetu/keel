# Shared helpers for the card pipeline. Sourced, never executed — every
# function here assumes the caller already has `set -euo pipefail`.
#
# esp_partition_offset/root_partition_offset need sfdisk and jq, which this
# repo does not assume the host has (macOS has neither); every caller that
# uses them runs inside the fedora:43 container where finalize-card.sh
# installs both. file_size_bytes, run_bib, boot_disk_under_qemu and
# wait_for_console are host-side, called from card.sh, qemu-test.sh and
# card-verify.sh directly.

ESP_GUID="C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
QEMU_FIRMWARE="${KEEL_QEMU_FIRMWARE:-/opt/homebrew/share/qemu}"

_keel_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# esp_partition_offset <disk>
# Prints "<start-sector> <size-sectors>" for the disk's EFI System Partition.
esp_partition_offset() {
    local disk="$1"
    sfdisk --json "${disk}" 2>/dev/null | jq -r --arg g "${ESP_GUID}" \
        '.partitiontable.partitions[]
         | select((.type | ascii_upcase) == $g)
         | "\(.start) \(.size)"' | head -1
}

# root_partition_offset <disk>
# Prints "<start-sector> <size-sectors> <node>" for the largest non-ESP
# partition — the root filesystem, since the ESP and /boot are fixed and
# small and it is the only one worth reclaiming from.
root_partition_offset() {
    local disk="$1"
    sfdisk --json "${disk}" 2>/dev/null | jq -r --arg g "${ESP_GUID}" '
        [.partitiontable.partitions[] | select((.type | ascii_upcase) != $g)]
        | max_by(.size)
        | "\(.start) \(.size) \(.node)"'
}

# file_size_bytes <path>
# `stat -f %z` is BSD/macOS; `stat -c %s` is everywhere this repo's
# containers and guests run.
file_size_bytes() {
    case "$(uname -s)" in
        Darwin) stat -f %z "$1" ;;
        *) stat -c %s "$1" ;;
    esac
}

# run_bib <image-tag> <outdir>
# The bootc-image-builder invocation that turns a container image into a raw
# disk, against this repo's blueprint.
run_bib() {
    local tag="$1" outdir="$2"
    podman run --rm --privileged \
        --security-opt label=type:unconfined_t \
        --volume "${outdir}:/output" \
        --volume /var/lib/containers/storage:/var/lib/containers/storage \
        --volume "${_keel_lib_dir}/config.toml:/config.toml:ro" \
        quay.io/centos-bootc/bootc-image-builder:latest \
        --type raw --rootfs ext4 --local "localhost/${tag}"
}

# boot_disk_under_qemu <disk> <vars-fd> <console-log> [qemu args...]
# The pflash/virtio/serial shape every QEMU boot in this repo shares. Extra
# arguments are the caller's: machine/cpu selection and netdev vary between a
# card-verify boot (no network needed) and a qemu-test boot (hostfwd for
# ssh). Sets QEMU_PID; the caller is responsible for killing it.
boot_disk_under_qemu() {
    local disk="$1" vars_fd="$2" console_log="$3"
    shift 3
    qemu-system-aarch64 "$@" -smp 4 -m 1024 \
        -drive "if=pflash,format=raw,readonly=on,file=${QEMU_FIRMWARE}/edk2-aarch64-code.fd" \
        -drive "if=pflash,format=raw,file=${vars_fd}" \
        -drive "if=virtio,format=raw,file=${disk}" \
        -nographic -serial "file:${console_log}" \
        -monitor none &
    QEMU_PID=$!
}

# wait_for_console <logfile> <pattern> <timeout-secs>
# Polls for `pattern` in `logfile`, failing early if $QEMU_PID has already
# exited. Silent either way — the caller prints what timed out and why.
wait_for_console() {
    local logfile="$1" pattern="$2" timeout_secs="$3"
    local deadline=$(( $(date +%s) + timeout_secs ))
    while [ "$(date +%s)" -lt "${deadline}" ]; do
        grep -q "${pattern}" "${logfile}" 2>/dev/null && return 0
        if [ -n "${QEMU_PID:-}" ] && ! kill -0 "${QEMU_PID}" 2>/dev/null; then
            return 1
        fi
        sleep 2
    done
    grep -q "${pattern}" "${logfile}" 2>/dev/null
}
