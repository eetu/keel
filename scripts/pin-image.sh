#!/usr/bin/env bash
# Resolve a container tag to a digest-pinned reference.
#
#   scripts/pin-image.sh docker.io/pihole/pihole:latest
#   -> docker.io/pihole/pihole@sha256:…
#
# Digests are never hand-typed: a placeholder that looks well-formed passes every
# check we have while pinning nothing, and a mistyped one fails at deploy time on
# the device rather than here.
#
# The pull is the point — podman only records the manifest-list digest once it
# has the image, and pinning the *index* rather than one architecture's manifest
# is what keeps the reference valid on both this machine and the board. The image
# also has to be in local storage for a bound-image build to find it.
set -euo pipefail

ref="${1:?usage: scripts/pin-image.sh <repo:tag> [arch]}"
arch="${2:-arm64}"

podman pull --arch "${arch}" --quiet "${ref}" >/dev/null
digest=$(podman image inspect "${ref}" --format '{{index .RepoDigests 0}}')
version=$(podman image inspect "${ref}" --format '{{index .Labels "org.opencontainers.image.version"}}')

printf '%s\n' "${digest}"
if [ -n "${version}" ] && [ "${version}" != "<no value>" ]; then
    printf '# %s is %s\n' "${ref}" "${version}" >&2
fi
