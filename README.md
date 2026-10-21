# claude-exporter

Export claude.ai conversations to Markdown, with the files Claude produced saved in their final versions.

The browser extension is only the authentication layer: it fetches JSON with your existing claude.ai login and
hands it to a program on your computer, which does everything else. Your session cookie never leaves the browser.

```
protocol/    messages between the two sides
core/        conversation JSON → { markdown, files }      pure, no browser, no network
extension/   fetches two things only: the chat list, and one chat
companion/   the program: pairs with browsers, lists, exports to disk
e2e/         full pipeline test with a real Chromium
```

Requires Node 22.18+. TypeScript runs directly; the TUI's `.tsx` goes through `tsx`; only the extension has a
build step.

## Run it

```sh
npm install
npm run build     # extension → extension/dist/
npm start         # the program; prints a pairing token
```

Load `extension/dist/` in the browser:

- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `extension/dist`
- **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `extension/dist/manifest.json`.
  If the popup shows *Grant access*, click it.

Open the extension popup, paste the token, Save & connect. The token is stored in
`~/.config/claude-exporter/token`, so this happens once.

Exports go to `~/claude-exports/` (change with `--out <dir>`), one folder per chat:

```
imparare_c-4da0e155/
  imparare_c.md          the conversation; links into files/
  files/                 every file Claude created, in its final version
  conversation.json      raw API data, to re-render later without fetching again
```

## Keys

`npm start` opens the TUI full screen. Until a browser connects it shows the pairing token; once a logged-in
browser is there, your chats load by themselves.

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

`npm run repl -w companion` starts a line-mode version instead (`list`, `export <n|url>`, `browsers`, `use`),
handy for scripting and debugging.

## Security model

- The program only listens on `127.0.0.1`.
- It accepts connections only from extension origins (web pages can't fake `Origin`), and only with the pairing
  token (which stops other extensions).
- The extension checks that a session exists but never reads or sends its value.
- The extension performs two read-only requests and nothing else, with validated parameters: even a compromised
  program can't make it delete, post or read anything other than your chat list and chats.
- File names from conversations are sanitized so a file can't be written outside its export folder.

## Tests

```sh
npm test          # unit tests: core (27) + companion (38)
npm run typecheck # all packages + e2e
npm run e2e       # needs Playwright's Chromium: npx playwright install chromium
```

- **core**: synthetic conversations, one behaviour per test, plus golden tests on real chats.
- **companion**: the hub against fake browsers (security checks, several browsers, routing, disconnects,
  timeouts), paging (server page caps, offsets ignored, duplicates), writing to disk, the TUI reducer as pure
  functions, and the TUI itself driven by keystrokes against a fake backend.
- **e2e**: the built extension in Chromium talks to the real CLI; a fake claude.ai serves a real conversation.
  Checks the exported dispensa file is byte-identical to the one Claude delivered.

Real conversations live in `core/test/fixtures/private/`, which is **gitignored**: they're personal data.
Without them the golden and e2e tests skip, so a fresh clone still passes.

## API notes

Undocumented and subject to change. Everything about its shape lives in `core/src/types.ts`.

| what | endpoint |
|---|---|
| chat list | `GET /api/organizations/{org}/chat_conversations_v2?limit&offset` → `{ data, has_more }` |
| one chat | `GET /api/organizations/{org}/chat_conversations/{id}?tree=true&rendering_mode=messages&render_all_tools=true` |

Both work from the extension's background with the browser's cookies (verified in Chrome and Firefox), with an
in-tab fallback if that ever stops working.
