# Claude Conversation Bookmarks (Chrome extension)

Bookmark messages or passages in claude.ai conversations, add notes, organize them into groups, and jump back to them quickly.

## Installation

1. Download or clone this folder
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `claude-bookmarks` folder
4. Reload any open claude.ai tabs

Other Chromium-based browsers (Edge, Brave, Arc, …) work the same way.

To update after changing the files, click the reload ↻ button on the extension's card in `chrome://extensions`, then reload the claude.ai tab.

## Usage

| Action | How |
|---|---|
| Bookmark a whole message | Hover over a message (yours or Claude's) and click the 🔖 at its top right (click again to remove) |
| Bookmark a passage | Select text → click **🔖 Bookmark selection**; the passage is highlighted when you jump back |
| Open / close the panel | The 🔖 tab on the right edge of the page, or `Alt+B` |
| Previous / next bookmark | `Alt+↑` / `Alt+↓` |
| Add a note | Type right after adding a bookmark, or click a bookmark's note field in the panel |
| Jump to a bookmark | Click it in the panel |
| Reorder | Drag a bookmark anywhere except its note field and buttons |
| Groups | **＋ Group** creates one; click its name to rename; ▾/▸ collapses it; drag its header to reorder groups |
| Move between groups | Drag a bookmark into a group (collapsed groups accept drops too) or back to the top to ungroup |
| Delete a group | 🗑 on the group header; its bookmarks move back to the ungrouped list |
| Sort by position | **⇅** sorts the bookmarks in each group by where they appear in the conversation |
| Browse all conversations | Click the extension's toolbar icon to search bookmarks across every conversation and jump straight to one |
| Back up | **Export / Import** in the popup (JSON; import merges and never overwrites) |

Bookmarked messages get an orange bar on their left edge, and bookmarked passages get a light yellow highlight.

## How it works

- Data lives in `chrome.storage.local`, one key per conversation (`conv:<conversation UUID>`), and never leaves your machine. Each entry stores the bookmarks in display order plus the conversation's groups.
- A bookmark is located by its role (you / Claude), a fingerprint of the message's first 200 characters, and its message index, so it still resolves after new messages are added earlier in the page. Passage bookmarks also store the quoted text and match it ignoring whitespace.
- If a message has been edited or you switch to another branch of the conversation, its bookmark is dimmed in the panel to show it can't be found on the current page.
- Dragging uses pointer events rather than HTML5 drag and drop, so it never triggers claude.ai's file-drop overlay.

## When claude.ai changes its layout

claude.ai's DOM may change over time. Claude's responses are detected by trying several selectors in order; if none match, the extension infers them from the conversation structure (any turn that contains no user message and isn't the input box is treated as a Claude response), so manual changes are usually unnecessary.

If the 🔖 button still doesn't appear, adjust `SEL_USER` / `SEL_ASSISTANT` at the top of `content.js`: inspect the outer elements of a user message and a Claude response in DevTools, update the selectors, then reload the extension in `chrome://extensions`.
