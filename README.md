# Worldbook Entry Search

SillyTavern third-party extension for searching entries in currently enabled worldbooks.

## Features

- Searches enabled worldbook entries by `comment` (Title/Memo) and primary keywords (`key`).
- Shows the source worldbook, UID, and keyword summary.
- Opens the matching worldbook and attempts to scroll to the selected entry.
- Saves up to 20 recent search terms in browser `localStorage` under `st-worldbook-entry-search-history`.
- Shortcut: `Ctrl+Shift+W` / `Cmd+Shift+W`.

## Install

Copy this folder to one of SillyTavern's third-party extension locations, then reload SillyTavern:

- Per-user install: `SillyTavern/data/<user>/extensions/st-worldbook-entry-search`
- Development install: `SillyTavern/public/scripts/extensions/third-party/st-worldbook-entry-search`

If the extension manager asks for a Git URL, put this folder in a Git repository first and install that repository URL.

## Notes

The extension uses SillyTavern's public extension context for loading worldbooks. It also uses the built-in worldbook editor opener. If your SillyTavern version changes the editor DOM, the extension will still open the correct worldbook and show a toast with the target entry title and UID.
