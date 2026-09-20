#!/usr/bin/env bash
# Resolve a container tag to a digest-pinned reference.
#
#   scripts/pin-image.sh docker.io/pihole/pihole:latest
#   -> docker.io/pihole/pihole:latest@sha256:…
#
# Digests are never hand-typed: a placeholder that looks well-formed passes every
# check we have while pinning nothing, and a mistyped one fails at deploy time on
# the device rather than here.
#
# **The index digest, not one architecture's.** A multi-arch tag is a manifest
# list, and the two digests are different values: pinning an instance gives a
# reference that resolves on the board and fails everywhere else, including in
# the build. `skopeo inspect --format {{.Digest}}` reports the list's own digest
# even under `--override-arch` — which is what `src/infra/registry.ts` already
# relies on when it resolves a moving tag at deploy time, so this prints what a
# deploy would.
#
# It used to `podman pull --arch` and read `RepoDigests[0]`, which is the
# *instance* digest: for kanidm 1.11.1 that produced
# `28c1d81757f2712a7…` where the list is `7c3d7ed868e91f78c…`, so the documented
# way to pin an image disagreed with the committed pins and with the deploy.
# podman is still the fallback for a machine with no skopeo, and it is marked as
# approximate for that reason.
set -euo pipefail

ref="${1:?usage: scripts/pin-image.sh <repo:tag> [arch]}"
arch="${2:-arm64}"
repo="${ref%%:*}"
# A tag may carry a digest already; the repository is everything before the tag.
case "${ref}" in */*:*) repo="${ref%:*}" ;; esac

if command -v skopeo >/dev/null 2>&1; then
    # --no-creds on the retry for the reason registry.ts gives: a stale stored
    # login is refused harder than anonymity, so a public image resolves without
    # credentials and 403s with them.
    digest=$(
        skopeo inspect --override-os linux --override-arch "${arch}" \
            --format '{{.Digest}}' "docker://${ref}" 2>/dev/null ||
            skopeo inspect --no-creds --override-os linux --override-arch "${arch}" \
                --format '{{.Digest}}' "docker://${ref}"
    )
    version=$(
        skopeo inspect --no-creds --override-os linux --override-arch "${arch}" \
            --format '{{index .Labels "org.opencontainers.image.version"}}' \
            "docker://${ref}" 2>/dev/null || true
    )
else
    printf '# skopeo not found: falling back to podman, whose digest is the\n' >&2
    printf '# architecture instance rather than the manifest list. Verify before pinning.\n' >&2
    podman pull --arch "${arch}" --quiet "${ref}" >/dev/null
    digest=$(podman image inspect "${ref}" --format '{{index .RepoDigests 0}}')
    digest="${digest#*@}"
    version=$(podman image inspect "${ref}" --format '{{index .Labels "org.opencontainers.image.version"}}')
fi

# Tag and digest both, which is the form the catalog uses: the digest is what
# pulls, and the tag is what makes a dependency PR name a version rather than
# seven characters of hex.
printf '%s@%s\n' "${ref}" "${digest}"
if [ -n "${version}" ] && [ "${version}" != "<no value>" ]; then
    printf '# %s is %s\n' "${ref}" "${version}" >&2
fi
