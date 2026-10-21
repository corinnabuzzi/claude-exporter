# Store submission notes

Material for the Chrome Web Store and addons.mozilla.org (AMO). The packages come from
`npm run package -w extension` → `extension/release/`.

## Before the first upload

- **Name.** "Claude" is Anthropic's trademark. A store can reject a listing, or take it down later, when the
  name reads as if it were official. "… for Claude" is the usual pattern for third-party tools and much safer
  than "Claude Exporter". Suggested: **Chat Exporter for Claude**. If you rename, change `name` and
  `default_title` in `extension/static/manifest.json`, and the labels in the popup and the TUI.
- **Firefox add-on ID.** `GECKO_ID` in `extension/build.mjs` is permanent once published. Pick it now.
- **Privacy policy URL.** Both stores need a public URL: link to `PRIVACY.md` in the public repository.
- **Terms.** The extension uses claude.ai's internal API, which isn't documented and isn't meant for third-party
  tools. Read Anthropic's current Consumer Terms before publishing, and check the bulk-export behaviour (the
  250 ms pause between list pages, the 300 ms between exports) is something you're comfortable defending.

## Listing text

**Short description** (Chrome: max 132 characters)

> Export your claude.ai chats to Markdown files, with every file Claude created. Works with a free program on your computer.

**Description**

> Export your Claude conversations to clean Markdown, together with the files Claude created during the chat, in
> their final versions.
>
> This extension is the browser half of Claude Exporter. It uses your existing claude.ai login to read your chat
> list and the chats you choose, and hands them to the Claude Exporter program running on your own computer. The
> program shows your chats in a searchable list, and saves each one as a folder: the conversation as Markdown, a
> files/ folder, and the raw data.
>
> • Nothing leaves your computer: no server, no account, no analytics
> • Read-only: the extension can't send messages, delete chats or change settings
> • Your session cookie is never read or sent anywhere
> • Only the active version of each chat: no abandoned edits or retries
>
> Requires the Claude Exporter program (free, open source): [link to releases]
>
> Not affiliated with or endorsed by Anthropic.

**Category**: Productivity (Chrome) / Other (AMO)

## Chrome Web Store: privacy tab

**Single purpose**

> Lets a program on the user's own computer read the user's claude.ai chats so it can export them to Markdown files.

**Permission justifications**

| permission | justification |
|---|---|
| `host_permissions: https://claude.ai/*` | Reads the user's chat list and the chats they choose to export, from claude.ai's API, with the user's existing login. |
| `cookies` | Checks whether a claude.ai session cookie exists, to show whether the user is logged in, and reads the active-organization cookie so the right chats are listed. The session cookie's value is never used or sent. |
| `scripting` | Fallback only: if a request from the extension's background is blocked, the same read-only request runs inside an already-open claude.ai tab. No other code is injected. |
| `storage` | Stores the pairing token and port used to connect to the local program. |
| `alarms` | Reconnects to the local program after the browser suspends the extension's background worker. |

**Remote code**: No. All code is in the package.

**Data usage disclosures**: tick **Personal communications** (the chats). Do not tick authentication information:
the session cookie is checked for existence only. Certify all three: not sold to third parties, not used for
purposes unrelated to the single purpose, not used for creditworthiness or lending.

## AMO: reviewer notes

The submission form has a field for notes to the reviewer. Suggested:

> The extension connects to a companion program on 127.0.0.1 (WebSocket, port 47823) and does nothing useful
> without it. To test: download the program for your platform from [releases link], run it, and paste the
> pairing token it shows into the extension popup. With a logged-in claude.ai session, the program then lists
> the chats; Enter exports one.
>
> background.js is bundled with esbuild, unminified. Source code: attached as claude-exporter-source-x.y.z.zip.
> To rebuild: Node 22.18+, `npm ci`, `npm run build -w extension` → `extension/dist/firefox/`.

Upload `extension/release/claude-exporter-source-<version>.zip` when AMO asks for source code. AMO asks because
the code is bundled.

**Data collection**: the manifest declares `data_collection_permissions: { required: ["none"] }`. Chats are
transmitted only to a program on the same device, never to the developer or third parties.

## Chrome Web Store: reviewer notes

Chrome reviewers can't test the extension without the program either. Use the same test instructions in the
"test instructions" field.
