# Privacy Policy — Claude Conversation Bookmarks

_Last updated: November 14, 2026_

Claude Conversation Bookmarks ("the extension") lets you bookmark messages and passages in your claude.ai conversations and jump back to them. This policy explains what data the extension handles and how.

The extension is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic.

## Summary

- All data stays on your device.
- The extension makes no network requests. It has no servers, analytics, or tracking.
- Nothing is sold, shared, or transferred to anyone.

## What data is stored

When you create a bookmark, the extension saves the following in your browser's local extension storage (`chrome.storage.local`):

- **Bookmark content**: whether the message is from you or Claude, a short excerpt of the message text (up to 200 characters, used to find the message again), and, for passage bookmarks, the selected text together with up to 32 characters before and after it
- **Your additions**: notes, group names, and the order and grouping of your bookmarks
- **Conversation details**: the conversation's ID, title, and URL, so the popup can list your bookmarks and open the right conversation
- **Message order**: short hashes of the messages in each bookmarked conversation, so bookmarks can be sorted by their position even when claude.ai hasn't loaded those messages yet
- **Settings**: your display preferences, such as "Sort by position in conversation"

The extension reads claude.ai pages only to provide its features: to show the bookmark button and panel, to identify the message or passage you bookmark, and to highlight and scroll to bookmarks. It does not record your browsing history, keystrokes, or any activity outside these features, and it runs only on `https://claude.ai/*`.

## How data is used and shared

Stored data is used only to display your bookmarks and jump to them. It is never transmitted off your device, and it is not sold, shared with third parties, used for advertising, or used to determine creditworthiness.

If you use **Export**, the extension creates a JSON file of your bookmarks on your device. That file is saved only where you choose, and what happens to it afterwards is up to you.

## Permissions

- **storage**: to save your bookmarks and settings locally
- **Access to https://claude.ai/\***: to add the bookmark features to claude.ai conversation pages

## Deleting your data

- Delete a single bookmark or group with its 🗑 button.
- Removing the extension from Chrome deletes all of its stored data.

## Changes to this policy

If this policy changes, the updated version will be published at this same address with a new "Last updated" date.

## Contact

For questions about this policy, please open an issue in this project's GitHub repository.
