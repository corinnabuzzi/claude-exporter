#!/usr/bin/env bash
# Points the PKGBUILD at a published release: version, checksums, .SRCINFO.
#   ./update.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")"

version="${1:?usage: ./update.sh <version>}"
version="${version#v}"
repo="https://github.com/corinnabuzzi/claude-exporter"
# overridable for testing against a local server
releases="${AUR_RELEASES_URL:-$repo/releases/download}"
raw="${AUR_RAW_URL:-$repo/raw}"

sums="$(curl -fsSL "$releases/v$version/SHA256SUMS")"
sum_for() { awk -v f="$1" '$2 == f { print $1 }' <<<"$sums"; }
x64="$(sum_for claude-exporter-linux-x64)"
arm64="$(sum_for claude-exporter-linux-arm64)"
if [[ -z "$x64" || -z "$arm64" ]]; then
  echo "SHA256SUMS of v$version has no Linux binaries" >&2
  exit 1
fi
license="$(curl -fsSL "$raw/v$version/LICENSE" | sha256sum | cut -d ' ' -f 1)"

sed -i \
  -e "s/^pkgver=.*/pkgver=$version/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=.*/sha256sums=('$license')/" \
  -e "s/^sha256sums_x86_64=.*/sha256sums_x86_64=('$x64')/" \
  -e "s/^sha256sums_aarch64=.*/sha256sums_aarch64=('$arm64')/" \
  PKGBUILD
makepkg --printsrcinfo > .SRCINFO

echo "PKGBUILD and .SRCINFO now point at v$version"
echo "test:    makepkg -si   (from this folder)"
echo "publish: see README.md in this folder"
