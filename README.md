# tuiline — LINE in your terminal

Original repo from [tuigram](https://github.com/leonid-shutov/tuigram)
![tuiline showing LINE chats and the sticker picker](screenshot-tuiline.png)

An OpenTUI client for LINE Messenger with its Go backend included in
[`backend/`](backend/). The interface stays in the terminal: chats on the left,
conversation history on the right, and a keyboard-operated composer.

## Run

Requires [Node.js 26.4+ and Go 1.26+](INSTALL.md). No other repository checkout is needed:

```sh
npm ci
npm run build:line
npm run dev
```

The build compiles the bundled backend into `backend-bin/line-gui` and applies
this client's patches, including support for up to 5,000 chats.
See [backend/UPSTREAM.md](backend/UPSTREAM.md) for source attribution.

Run these commands from the `tuiline` repository root. `npm run dev`
automatically uses `./backend-bin/line-gui`; no backend path is needed.

Try fictional chats without signing in or contacting LINE:

```sh
npm run dev -- --demo
```

## Keys

The interface uses your terminal's default foreground/background and ANSI 16-color
palette, including its green accent. Selections and reply highlights use palette
colors too, so your terminal theme controls the UI rather than fixed RGB colors.
Selected messages outside reply threads use ANSI blue (slot 4) with black text
(slot 0). Reply threads alternate gray backgrounds (slots 7 and 8), with bright-white
text (slot 15); the `›` marker indicates the selected message within a thread.

The package and command are named `tuiline` (`node bin/tuiline.js` or `npm run dev`
from this checkout). Upstream attribution and legacy saved-data compatibility keep
their original names.
The npm installer requires a published `tuiline` release; renaming this checkout
does not publish one. The source-build instructions above work without npm publication.

| Key                      | Action                                                          |
| ------------------------ | --------------------------------------------------------------- |
| Up/Down, j/k             | Select a sidebar chat or move the message cursor in scroll mode |
| h / l                    | Leave / enter conversation focus (outside insert mode)          |
| Tab                      | Switch sidebar / conversation scroll mode                       |
| Enter from sidebar       | Focus conversation in scroll mode                               |
| @ in insert mode         | Search group members and insert a LINE mention                  |
| i                        | Enter insert mode                                               |
| s                        | Browse owned stickers; Enter previews, Enter again sends        |
| l on an image or sticker | Fit full height; l again fills width; j/k scroll                |
| l on a video             | Play inside the right pane; h, q, or Escape returns             |
| Enter in insert mode     | Send text                                                       |
| Escape                   | Return to scroll mode, preserving your draft                    |
| Ctrl+F / Ctrl+B          | Move a full page down / up in scroll mode                       |
| Ctrl+D / Ctrl+U          | Move half a page down / up in scroll mode                       |
| gg / G                   | Jump to the top / bottom of the focused list                    |
| PageUp/PageDown          | Scroll loaded history                                           |
| g then x                 | Open links in the marked message; pick a link if several        |
| Ctrl+R                   | Refresh                                                         |
| Ctrl+S in scroll mode    | Save the selected attachment to your system Downloads folder    |
| Ctrl+T                   | Pick files and upload them immediately to the current chat      |
| Ctrl+L                   | Start or retry QR login                                         |
| Ctrl+Y                   | Confirm login when requested                                    |
| Ctrl+X                   | Cancel login                                                    |
| Ctrl+C                   | Quit                                                            |

File transfers support up to **20 MiB per file**. Ctrl+S saves the selected file,
image, video, or audio attachment directly to your system Downloads folder (XDG),
adding a numeric suffix when the filename already exists; existing files are never
overwritten. Ctrl+T uses `zenity` or `kdialog` for multi-file selection when a desktop
session is available. Install either picker for graphical selection. If neither is
usable, enter paths in the terminal prompt, separated by spaces; quote paths that
contain spaces, for example `"~/Documents/my report.pdf" ~/photo.jpg`. Press Enter
to upload immediately, or Escape to cancel. Files are sent individually, preserving
your text draft. An uncertain send stops the queue: check LINE before retrying.
Rebuild the backend with `npm run build:line` after updating.

In a group chat, press `i` to type, then type `@` to list group members.
Type part of a name to filter, use Up/Down to select, and press Enter or Tab
to insert the mention. Press Escape to close the list. After composing your
message, press Enter to send it with native LINE mention metadata. You can
include up to 20 mentions and combine mentions with a reply.

Scan the QR code in the terminal using LINE on your phone, then follow the
PIN/confirmation prompts. Authentication and encryption remain managed by the
reference backend, including its Secret Service requirements. This client uses
the same saved account as that backend. Avoid simultaneous clients using the
same session if the backend reports it is locked.

Login progress and failure messages are saved to `./tuiline-login.log`.
Press `Ctrl+C` to quit and print the recent login diagnostics in the terminal,
or watch them from another terminal in the repository directory:

```sh
tail -F ./tuiline-login.log
```

The log excludes PINs, QR data, credentials, and chat contents.

This version supports listing chats, loading the latest history, text sending,
live incoming updates, and terminal image rendering. In scroll mode, the `›`
marker identifies the selected message; `l`/`L` opens links from that message.
Uppercase `J`/`K`/`H`/`L` also work for navigation.
Selecting an image message loads its inline PNG/JPEG preview (up to 2 MiB and
4096×4096). Sticker images supplied by the backend render inline automatically.
Press `s` outside insert mode to browse owned sticker packs in a compact four-column
thumbnail grid. Use `h`/`l` to move left/right and `j`/`k` to move down/up;
arrow keys also work. The grid scrolls to keep the highlight visible. Use
`[`/`]` to switch packs, and `n`/`p` for pages. Enter selects a sticker for preview;
Enter again sends it, while Escape cancels. Clear any text draft before sending a
sticker. Sticker previews are static and silent, matching the reference backend;
custom text/name stickers remain unsupported.
Page navigation continues across pack boundaries; the header shows both the
overall page count and the current pack's pages. Generated backend labels and
the sticker picker use Traditional Chinese. Contact names, pack titles, and
message contents stay as received from LINE.
The preview cache evicts older images as you browse packs; the highlighted
sticker loads first. Press `r` to retry a missing preview.
OpenTUI chooses the terminal's image protocol, with Unicode blocks as a fallback.
Failed or unsupported images retain their text placeholder. Previews are held
in memory with a bounded cache and cleared when switching conversations.

Video playback requires mpv. Press `l` on a video to play it inside the right
pane while the chat list stays visible. `Space` pauses, left/right arrows seek
five seconds, and `h`, `q`, or Escape returns to the conversation. Frames update
at up to 12 fps using the terminal image protocol (or Unicode blocks as a fallback).
Escape also cancels a pending download.
Temporary video files are removed after playback. The backend limits downloads
to 20 MiB.

While a video downloads, the pane shows a progress bar with bytes received and,
when LINE supplies the total size, a percentage. Escape cancels the download.

Outgoing messages show `✓` after sending and `✓✓` when a live read receipt is
observed. In groups, this means at least one other member has read the message.
Receipts are session-local; older reads are not inferred from history. The TUI
does not automatically mark incoming messages as read.

Attachment sending, reactions, and message actions have no
TUI controls yet. History is limited to 100 messages per chat. The local build
supports 5,000 chats. Drafts live in memory.
Uncertain sends are shown and blocked from
automatic resending; check LINE and refresh before deliberately trying again.
Desktop notifications are enabled through `notify-send` while the app is running.
Group notifications show the group name, sender, and message preview; direct
notifications show the sender and message preview.

The original Telegram implementation is available with `npm run dev:telegram`;
its original documentation is in [docs/TELEGRAM.md](docs/TELEGRAM.md). Existing
Telegram configuration is separate from the LINE backend's session.
