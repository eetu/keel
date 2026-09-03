#!/usr/bin/env bash
# Render the image tree and build the aarch64 image. One image serves every
# host; a board's identity comes from keel.conf on its ESP.
#
#   image/build.sh [tag]
set -euo pipefail

tag="${1:-keel:latest}"

cd "$(dirname "$0")/.."

yarn render

# The image's one piece of provenance, taken from the build that produced it
# rather than from a constant in the Containerfile: whoever builds this — a fork,
# a mirror, this repo's CI — gets a label naming their own repository, and no
# account name of anyone else's rides along in every image. CI states it outright
# from the repository it checked out; anywhere else the remote is the answer, with
# an ssh remote rewritten to the https form a registry can follow. A clone with
# neither yields nothing, which is the truthful label for an image whose origin
# cannot be named.
source_url="${SOURCE_URL:-$(git remote get-url origin 2>/dev/null || true)}"
source_url=$(printf '%s' "${source_url}" | sed -e 's#^git@\([^:]*\):#https://\1/#' -e 's#\.git$##')

podman build --arch arm64 --build-arg "SOURCE_URL=${source_url}" \
    --tag "${tag}" --file image/Containerfile .

echo "built ${tag}"
