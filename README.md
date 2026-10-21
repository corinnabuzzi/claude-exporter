# Chat Exporter for Claude

Export claude.ai conversations to Markdown, with the files Claude produced saved in their final versions.

The browser extension is only the authentication layer: it fetches JSON with your existing claude.ai login and
hands it to a program on your computer, which does everything else. Your session cookie never leaves the browser,
and nothing goes to any server. See [PRIVACY.md](PRIVACY.md).

Not affiliated with or endorsed by Anthropic.

## Install

You need two pieces: the **program**, which does the work, and the **browser extension**, which lets it read
your chats.

### 1. The program

**Linux and macOS**, one line:

```sh
curl -fsSL https://raw.githubusercontent.com/corinnabuzzi/claude-exporter/main/install.sh | sh
```

It picks the right build for your system, checks it against the release's checksums, installs it to
`~/.local/bin` (no sudo), and runs it once to make sure it works. If that folder isn't on your PATH yet, it
says what to add. To pin a version, put `CLAUDE_EXPORTER_VERSION=0.1.0` in front of `sh`; to install elsewhere,
`CLAUDE_EXPORTER_INSTALL_DIR=…`.

**Arch Linux**, as a pacman package, so it updates with the rest of your system. It's going on the AUR as
`claude-exporter-bin` (new AUR accounts are paused right now). Until then, build the same package from this repo:

```sh
git clone https://github.com/corinnabuzzi/claude-exporter.git
cd claude-exporter/packaging/aur
makepkg -si
```

To update, run `git pull` in that folder, then `makepkg -si` again.

**Windows**, or by hand: download the file for your system from
[Releases](https://github.com/corinnabuzzi/claude-exporter/releases). On Windows, SmartScreen may warn about an
unknown publisher: "More info" → "Run anyway".

### 2. The extension

From the Chrome Web Store or Firefox Add-ons (links once published). Until then, see *Development* below to
load it by hand.

### 3. Pair them, once

Run `claude-exporter`. It shows a pairing token: open the extension's popup, paste it, Save & connect.

From then on, the browser reconnects by itself, usually within a few seconds. A sleeping browser can take up to
30 seconds, and clicking the extension icon skips the wait. If something is wrong (a different token, an
outdated extension or program), both the program and the popup say what to do.

### Uninstall

Remove the extension from the browser, then the program: `rm ~/.local/bin/claude-exporter` (or
`sudo pacman -R claude-exporter-bin`), plus `~/.config/claude-exporter` for the pairing token. Your exports stay in
`~/claude-exports` until you delete them.

Exports go to `~/claude-exports/` (`--out <dir>` to change), one folder per chat:

```
imparare_c-4da0e155/
  imparare_c.md          the conversation; links into files/
  files/                 every file Claude created, in its final version
  conversation.json      raw API data, to re-render later without fetching again
```

`claude-exporter --help` lists the options.

## Keys

The program opens full screen. Until a browser connects it shows the pairing token; once a logged-in browser is
there, your chats load by themselves.

| key | |
|---|---|
| `↑` `↓` / `j` `k` | move · `PgUp` `PgDn`, `Home`/`g`, `End`/`G` jump |
| `space` | select the chat under the cursor |
| `a` | select / unselect everything visible (works on search results) |
| `enter` | export the selection, or the chat under the cursor if nothing is selected |
| `/` | search title, project and summary as you type; `enter` keeps the filter, `esc` clears it |
| `esc` | clear the filter, then the selection |
| `r` | reload the list |
| `b` | switch browser, when more than one is connected |
| `q` | quit (asks twice while exports are running) |

Exports run one at a time in the background: `·` queued, spinner running, `✓` done (yellow if a file has
warnings), `✗` failed; put the cursor on a failed one to see why. After quitting, the exported folders are
listed in the terminal.

Several browsers can be connected at once. Requests go to the one picked with `b`, otherwise to the newest one
that's logged in.

## Development

```
protocol/    messages between the two sides
core/        conversation JSON → { markdown, files }      pure, no browser, no network
extension/   fetches two things only: the chat list, and one chat
companion/   the program: pairs with browsers, lists, exports to disk, TUI
e2e/         full pipeline test with a real Chromium
```

Requires Node 22.18+. TypeScript runs directly and the TUI's `.tsx` goes through `tsx`. The extension is
bundled with esbuild, and the release binaries need [Bun](https://bun.sh).

```sh
npm install
npm run build     # extension → extension/dist/chrome and extension/dist/firefox
npm start         # the TUI, straight from source
```

Load the extension by hand:

- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `extension/dist/chrome`
- **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
  `extension/dist/firefox/manifest.json`. If the popup shows *Grant access*, click it.

`npm run repl -w companion` starts a line-mode version instead (`list`, `export <n|url>`, `browsers`, `use`),
handy for debugging.

### Tests

```sh
npm test          # unit tests for every package
npm run typecheck # all packages + e2e
npm run e2e       # needs Playwright's Chromium: npx playwright install chromium
```

- **core**: synthetic conversations, one behaviour per test, plus golden tests on real chats.
- **companion**: the hub against fake browsers (security checks, several browsers, routing, disconnects,
  timeouts), paging (server page caps, offsets ignored, duplicates), writing to disk, the TUI reducer as pure
  functions, and the TUI itself driven by keystrokes against a fake backend.
- **e2e**: the built Chrome extension talks to the real program; a fake claude.ai serves a real conversation.
  Checks the exported dispensa file is byte-identical to the one Claude delivered.

Real conversations live in `core/test/fixtures/private/`, which is **gitignored**: they're personal data.
Without them the golden and e2e tests skip, so a fresh clone still passes.

`npm audit` reports `node-forge` advisories: they come from `web-ext`'s Android debugging dependency, a dev-only
tool that never ships and whose signature verification we don't use.

### Building releases

```sh
npm run package -w extension       # store zips + source archive → extension/release/
cd companion && bun build.ts       # binary for this machine → dist/
cd companion && bun build.ts --all # Linux, macOS (Intel + Apple Silicon), Windows
```

To publish: bump `version` in every `package.json`, commit, then tag and push:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The `release` workflow checks the tag against the package versions, runs the tests, and builds everything. It
signs the macOS builds on a Mac, launches the Linux, macOS (Apple Silicon) and Windows binaries on their own
systems, and creates a **draft** release with checksums. After it finishes:

1. Review the draft and publish it. `install.sh` only sees published releases.
2. Upload the two extension zips to the stores (see [STORE.md](STORE.md)).
3. Update the AUR package (see [packaging/aur/README.md](packaging/aur/README.md)).

## Security model

The extension and the program prove to each other that they hold the same pairing token, and **the program
goes first**: the extension serves nothing to whatever is listening on the port until it has checked. Each side
sends a random nonce and gets back an HMAC-SHA256 of both nonces keyed with the token. The token itself never
crosses the connection. The two proofs carry different labels (`program` / `extension`), so one can't be
bounced back as the other, and fresh nonces make recorded proofs useless.

- The program only listens on `127.0.0.1`, and refuses web pages (by `Origin`, which browsers don't let pages
  fake) before the handshake even starts.
- The extension checks that a claude.ai session exists but never reads or sends its value.
- The extension performs two read-only requests and nothing else, with validated parameters: even a compromised
  program can't make it delete, post or read anything other than your chat list and chats.
- Exports are private to your user account (folders `0700`, files `0600`), and file names from conversations
  are sanitized so nothing can be written outside its export folder.

What this protects against: other user accounts on the same computer, sandboxed apps, and anything that takes
the port while the program isn't running. What it can't protect against: software already running as *your*
user, which can read the token file and your browser's cookies directly. Nothing at this level can.

Versions 0.1.x sent the token in plain text to whatever was listening on the port, without checking it was the
program. Fixed in 0.2.0: update both the extension and the program.

## API notes

Undocumented and subject to change. Everything about its shape lives in `core/src/types.ts`.

| what | endpoint |
|---|---|
| chat list | `GET /api/organizations/{org}/chat_conversations_v2?limit&offset` → `{ data, has_more }` |
| one chat | `GET /api/organizations/{org}/chat_conversations/{id}?tree=true&rendering_mode=messages&render_all_tools=true` |

Both work from the extension's background with the browser's cookies (verified in Chrome and Firefox), with an
in-tab fallback if that ever stops working.
