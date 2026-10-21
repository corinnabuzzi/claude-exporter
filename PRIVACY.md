# Privacy policy

*Chat Exporter for Claude: browser extension and companion program. Last updated: 21 October 2026.*

Chat Exporter for Claude is an independent project. It is not made by, affiliated with, or endorsed by Anthropic.

## In short

Your chats go from claude.ai to a program running on your own computer, and nowhere else. There is no server,
no account, no analytics, and no tracking.

## What the extension reads

- **Your claude.ai chat list and the chats you choose to export**, using the login you already have in the
  browser. It makes two kinds of read-only requests to claude.ai and nothing else: it cannot send messages,
  delete chats, or change any setting.
- **Two claude.ai cookies.** It checks that your session cookie exists, to know whether you're logged in. It
  never uses or sends that cookie's value. It reads the cookie that says which organization you're currently
  using, so the right chats are listed.

## Where the data goes

- **Only to the Chat Exporter for Claude program on the same computer**, over a connection to `127.0.0.1` (your own
  machine). That connection only works from the extension, and only after you pair it with the program using a
  token the program shows you.
- **Nothing is sent to the developer or to any third party.** The extension and the program contain no
  analytics, telemetry, crash reporting, or advertising.

## What is stored

- **In the extension**: the pairing token and port number, in the browser's local extension storage.
- **By the program**: the pairing token, in `~/.config/claude-exporter/token`.
- **Your exports**: in the folder you choose (by default `~/claude-exports`), as Markdown, the files Claude
  created, and the raw conversation data. They stay there until you delete them.

Uninstalling the extension removes what it stored. Deleting the program, its config folder and your exports
folder removes everything else.

## Sharing and selling

Your data is not sold, shared, or used for anything other than creating the exports you ask for.

## Contact

Questions or concerns: open an issue at https://github.com/corinnabuzzi/claude-exporter/issues.
