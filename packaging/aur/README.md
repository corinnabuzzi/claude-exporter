# AUR package: claude-exporter-bin

Installs the prebuilt binary from GitHub Releases. The `-bin` suffix is the AUR convention for packages that
don't build from source. Users install it with `yay -S claude-exporter-bin` (or any AUR helper), and get
updates with their normal system updates.

## First time

1. Create an account on https://aur.archlinux.org and add your SSH public key in *My Account*.
2. Make sure the release you're packaging is **published** (not a draft): the PKGBUILD downloads from it.
3. Point the PKGBUILD at it and test the build on your machine:

   ```sh
   cd packaging/aur
   ./update.sh 0.1.0
   makepkg -si          # builds, runs check(), installs
   claude-exporter --version
   ```

4. Publish. The AUR repo is created by your first push:

   ```sh
   git clone ssh://aur@aur.archlinux.org/claude-exporter-bin.git ~/aur/claude-exporter-bin
   cp PKGBUILD .SRCINFO ~/aur/claude-exporter-bin/
   cd ~/aur/claude-exporter-bin
   git add PKGBUILD .SRCINFO
   git commit -m "claude-exporter-bin 0.1.0"
   git push
   ```

## Every release

```sh
cd packaging/aur
./update.sh 0.2.0 && makepkg -si
cp PKGBUILD .SRCINFO ~/aur/claude-exporter-bin/
cd ~/aur/claude-exporter-bin && git commit -am "claude-exporter-bin 0.2.0" && git push
```

Commit `PKGBUILD` and `.SRCINFO` in this repo too, so the next update starts from the published state.

If only the packaging changes (not the program), bump `pkgrel` by hand instead of running `update.sh`, then
run `makepkg --printsrcinfo > .SRCINFO`.

## Rules for this PKGBUILD

- **Never remove `!strip`.** Stripping deletes the program from the binary and leaves bare Bun. It happens
  after `check()`, so the build can't catch it. Tested: without `!strip`, the package builds fine and installs
  a binary that prints Bun's version.
- The release must contain `LICENSE` at the tag, since the package installs it.
