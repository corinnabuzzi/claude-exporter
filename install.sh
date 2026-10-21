#!/bin/sh
# Installs the Chat Exporter for Claude program on Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/corinnabuzzi/claude-exporter/main/install.sh | sh
#
# Options, as environment variables:
#   CLAUDE_EXPORTER_VERSION       e.g. 0.2.0 (default: latest release)
#   CLAUDE_EXPORTER_INSTALL_DIR   default: ~/.local/bin (no sudo needed)
set -eu

REPO="corinnabuzzi/claude-exporter"
NAME="claude-exporter"
VERSION="${CLAUDE_EXPORTER_VERSION:-latest}"
INSTALL_DIR="${CLAUDE_EXPORTER_INSTALL_DIR:-$HOME/.local/bin}"
# only for testing against a local server or a mirror
BASE_URL="${CLAUDE_EXPORTER_BASE_URL:-}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system: $(uname -s). On Windows, download the .exe from https://github.com/$REPO/releases" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported processor: $(uname -m)" ;;
esac

# a terminal running under Rosetta reports x86_64 on an Apple Silicon Mac: get the native build
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

asset="$NAME-$os-$arch"
if [ -z "$BASE_URL" ]; then
  if [ "$VERSION" = latest ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
  else
    BASE_URL="https://github.com/$REPO/releases/download/v${VERSION#v}"
  fi
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "needs curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "needs sha256sum or shasum to verify the download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($VERSION)…"
fetch "$BASE_URL/$asset" "$tmp/$asset" || fail "download failed: $BASE_URL/$asset"
fetch "$BASE_URL/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download the checksums"

expected="$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "no checksum listed for $asset"
[ "$(sha256 "$tmp/$asset")" = "$expected" ] || fail "checksum mismatch: the download is corrupt or was tampered with"

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
# a downloaded file can carry the quarantine flag that makes Gatekeeper block it
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$tmp/$asset" 2>/dev/null || true
mv -f "$tmp/$asset" "$INSTALL_DIR/$NAME"

# proves the binary actually runs here, not just that it downloaded
installed="$("$INSTALL_DIR/$NAME" --version 2>/dev/null)" || fail "installed to $INSTALL_DIR/$NAME, but it doesn't run on this system"
say "✓ installed $NAME $installed to $INSTALL_DIR"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) say "run it with: $NAME" ;;
  *)
    say ""
    say "$INSTALL_DIR isn't on your PATH yet. Add this line to your shell's config (~/.bashrc, ~/.zshrc…):"
    say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    say "then open a new terminal and run: $NAME"
    ;;
esac

if [ -f /etc/arch-release ]; then
  say ""
  say "tip: on Arch, you can install it as a pacman package instead, so it updates with your system:"
  say "  https://github.com/$REPO#install"
fi

say ""
say "next: install the browser extension, then paste the pairing token the program shows."
say "  https://github.com/$REPO#install"
