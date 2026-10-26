// Claude Conversation Bookmarks — content script (injected into claude.ai)
(() => {
  'use strict';
  if (window.__cbmLoaded) return;
  window.__cbmLoaded = true;

  // ===== Selectors: if a claude.ai redesign breaks message detection, this is the only place to change =====
  const SEL_USER = '[data-testid="user-message"]';
  // Claude's responses: try these selectors in order; if all fail, infer from the conversation structure (see guessAssistant)
  const SEL_ASSISTANT = [
    '.font-claude-response',
    '.font-claude-message',
    '[data-testid="assistant-message"]',
    '[data-is-streaming]',
  ].join(', ');
  const SEL_INPUT = 'textarea, [contenteditable="true"], fieldset, form';

  const PENDING_KEY = 'cbm_pending';
  const PANEL_PREF = 'cbm_panel_open';
  const JUMP_OFFSET = 80; // pixels between the jump target and the top of the scroll area
  const convKey = (id) => `conv:${id}`;
  const HL = !!(window.CSS && CSS.highlights && window.Highlight);

  // ===== Utilities =====
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const strip = (s) => (s || '').replace(/\s+/g, '');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const getConvId = () => (location.pathname.match(/\/chat\/([0-9a-f-]{16,})/i) || [])[1] || null;
  const getTitle = () => norm(document.title.replace(/\s*[-–|]\s*Claude\s*$/i, '')) || 'Untitled conversation';
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const isEditable = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const isOurs = (t) => !!(t && t.closest && t.closest('.cbm-ui'));
  const fingerprint = (el) => norm(el.textContent).slice(0, 200);
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // When no selector matches Claude's responses: find the container holding all conversation turns;
  // any turn that has no user message and isn't the input box is treated as a Claude response
  function guessAssistant(users) {
    let list = null;
    if (users.length >= 2) {
      for (let p = users[0].parentElement; p && p !== document.body; p = p.parentElement) {
        if (users.every((u) => p.contains(u))) { list = p; break; }
      }
    } else {
      for (let p = users[0]; p.parentElement && p.parentElement !== document.body; p = p.parentElement) {
        const sib = [...p.parentElement.children].some((c) => c !== p && !c.querySelector(SEL_USER) && !c.querySelector(SEL_INPUT) && norm(c.textContent).length > 20);
        if (sib) { list = p.parentElement; break; }
      }
    }
    if (!list) return [];
    return [...list.children].filter((c) =>
      !c.matches(SEL_USER) && !c.querySelector(SEL_USER) &&
      !c.matches(SEL_INPUT) && !c.querySelector(SEL_INPUT) &&
      !isOurs(c) && norm(c.textContent).length > 0);
  }

  // List all (outermost) messages in document order; the cache is cleared on DOM changes
  let msgCache = null;
  function getMessages() {
    if (msgCache) return msgCache;
    const users = [...document.querySelectorAll(SEL_USER)];
    const userSet = new Set(users);
    let assists = [...document.querySelectorAll(SEL_ASSISTANT)].filter((el) =>
      !isOurs(el) && !el.closest(SEL_USER) && !el.querySelector(SEL_USER) && !el.querySelector(SEL_INPUT));
    if (!assists.length && users.length) assists = guessAssistant(users);
    const nodes = [...users, ...assists];
    const set = new Set(nodes);
    const top = nodes
      .filter((n) => { for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; })
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const msgs = top.map((el, index) => ({ el, index, role: userSet.has(el) ? 'user' : 'assistant' }));
    const base = msgs.length ? alignWindow(msgs.map((m) => keyOf(m.role, fpOf(m))), contentY(msgs[0].el)) : null;
    for (const m of msgs) m.abs = base == null ? null : base + m.index;
    msgCache = msgs;
    return msgCache;
  }

  // Find the message element that contains a node
  function topMessage(node) {
    if (!node || isOurs(node.nodeType === 1 ? node : node.parentElement)) return null;
    const m = getMessages().find((x) => x.el.contains(node));
    return m ? m.el : null;
  }
  const fpOf = (m) => (m.fp ??= fingerprint(m.el));

  // ===== Conversation order =====
  // claude.ai keeps only part of a long conversation in the page (messages load as you scroll), so a
  // message's index among the loaded ones isn't its position in the conversation. Every loaded window
  // of messages is merged into what has been seen so far (state.seq, saved with the bookmarks):
  // windows that share messages are aligned into one segment; a window that shares nothing (after a
  // jump or a scrollbar drag) becomes its own segment, ordered by its vertical position in the page.
  // Segments that later turn out to touch are merged. Flattened, the segments give every message an
  // absolute position (m.abs) whose order matches the conversation.
  const hash = (s) => {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return (x >>> 0).toString(36);
  };
  const keyOf = (role, fp) => (role === 'user' ? 'u' : 'a') + hash(fp || '');
  let seqSaveT = null;

  // Best alignment of keys against a segment: { off, votes } (off = segment index of keys[0])
  function bestOffset(segKeys, keys, hint = 0) {
    const at = new Map();
    segKeys.forEach((k, j) => { if (!at.has(k)) at.set(k, []); at.get(k).push(j); });
    const votes = new Map();
    keys.forEach((k, i) => (at.get(k) || []).forEach((j) => votes.set(j - i, (votes.get(j - i) || 0) + 1)));
    let best = null;
    for (const [off, v] of votes) {
      if (!best || v > best.votes || (v === best.votes && Math.abs(off - hint) < Math.abs(best.off - hint))) best = { off, votes: v };
    }
    return best;
  }

  // Write keys into seg at offset off (prepending/appending as needed); returns keys[0]'s new index
  function mergeInto(seg, keys, off) {
    let changed = false;
    if (off < 0) { seg.keys.unshift(...keys.slice(0, -off)); off = 0; changed = true; }
    keys.forEach((k, i) => { if (seg.keys[off + i] !== k) { seg.keys[off + i] = k; changed = true; } });
    return { off, changed };
  }

  // Merge the loaded window (keys in page order, y = its top in the scroll content) into state.seq.
  // Returns the absolute position of the window's first message.
  function alignWindow(keys, y) {
    if (!keys.length) return null;
    const segs = state.seq;
    const hits = segs.map((seg) => ({ seg, m: bestOffset(seg.keys, keys, seg.hint || 0) })).filter((x) => x.m);
    let changed = false;
    let seg;
    let off;
    if (!hits.length) {
      // nothing in common with what we've seen: a new segment, placed by its vertical position
      seg = { y, keys: keys.slice() };
      const at = segs.findIndex((s) => s.y > y);
      segs.splice(at < 0 ? segs.length : at, 0, seg);
      off = 0;
      changed = true;
    } else {
      hits.sort((a, b) => b.m.votes - a.m.votes);
      seg = hits[0].seg;
      const r = mergeInto(seg, keys, hits[0].m.off);
      off = r.off;
      changed = r.changed;
      if (off === 0) seg.y = y;
      // the window also touches other segments: they belong to this one
      for (const { seg: other } of hits.slice(1)) {
        const m = bestOffset(seg.keys, other.keys);
        if (!m) continue;
        mergeInto(seg, other.keys, m.off);
        if (m.off < 0) off += -m.off; // seg grew at the front
        segs.splice(segs.indexOf(other), 1);
        changed = true;
      }
      seg.hint = off;
    }
    if (changed && state.items.length) { clearTimeout(seqSaveT); seqSaveT = setTimeout(save, 1500); }
    let base = 0;
    for (const s of segs) { if (s === seg) break; base += s.keys.length; }
    return base + off;
  }

  // Top of an element in its scroll container's content coordinates
  function contentY(el) {
    const sc = getScroller(el);
    return el.getBoundingClientRect().top - scrollerTop(sc) + (sc.scrollTop || 0);
  }

  const allKeys = () => state.seq.flatMap((s) => s.keys);

  // Seen in this conversation (possibly not loaded right now)?
  const isKnown = (bm) => state.seq.some((s) => s.keys.includes(keyOf(bm.role, bm.fp)));

  // Absolute position of a bookmark's message, also when it isn't loaded right now
  function absPos(bm, msgs = getMessages()) {
    const m = locate(bm, msgs);
    if (m && m.abs != null) { bm.pos = m.abs; return m.abs; }
    const k = keyOf(bm.role, bm.fp);
    const ref = bm.pos ?? bm.index ?? 0;
    let found = null;
    allKeys().forEach((x, j) => { if (x === k && (found == null || Math.abs(j - ref) < Math.abs(found - ref))) found = j; });
    return found ?? ref;
  }

  // ===== Data =====
  // items: bookmarks in display order; each has groupId (null = ungrouped)
  // groups: [{ id, name, collapsed }] in display order
  const state = { convId: null, items: [], groups: [], seq: [] };
  let lastSavedTitle = '';

  function applyConv(conv) {
    state.items = conv?.items || [];
    state.groups = conv?.groups || [];
    state.seq = Array.isArray(conv?.seq) ? conv.seq.filter((s) => s && Array.isArray(s.keys)).map((s) => ({ y: s.y, keys: [...s.keys] })) : [];
    // Data saved before manual ordering existed: start in conversation order
    if (conv && !conv.ordered) state.items.sort((a, b) => a.index - b.index || a.createdAt - b.createdAt);
    const ids = new Set(state.groups.map((g) => g.id));
    for (const b of state.items) if (!ids.has(b.groupId)) b.groupId = null;
  }

  async function load() {
    state.convId = getConvId();
    applyConv(null);
    if (!state.convId || !alive()) return;
    const r = await chrome.storage.local.get(convKey(state.convId));
    const conv = r[convKey(state.convId)];
    applyConv(conv);
    lastSavedTitle = conv?.title || '';
  }

  async function save() {
    const id = state.convId;
    if (!id || !alive()) return;
    const k = convKey(id);
    if (!state.items.length && !state.groups.length) { await chrome.storage.local.remove(k); return; }
    lastSavedTitle = getTitle();
    await chrome.storage.local.set({
      [k]: {
        id, title: lastSavedTitle, url: `${location.origin}/chat/${id}`, updatedAt: Date.now(),
        ordered: true, items: state.items, groups: state.groups, seq: state.seq.map((s) => ({ y: Math.round(s.y), keys: s.keys })),
      },
    });
  }

  // ===== Locate a bookmark's message =====
  function locate(bm, msgs = getMessages()) {
    const ref = bm.pos ?? bm.index;
    const dist = (m) => Math.abs((m.abs ?? m.index) - ref);
    const near = (arr) => arr.sort((a, b) => dist(a) - dist(b))[0];
    const same = msgs.filter((m) => m.role === bm.role);
    let c = same.filter((m) => fpOf(m) === bm.fp);
    if (c.length && bm.quote) {
      // identical messages: prefer the one that still contains the passage
      const withQuote = c.filter((m) => quoteMatch(strip(m.el.textContent), bm));
      if (withQuote.length) c = withQuote;
    }
    if (c.length) return near(c);
    if (bm.quote) {
      // message changed: pick the message whose passage context matches best, then the nearest one
      const scored = msgs
        .map((m) => ({ m, mt: quoteMatch(strip(m.el.textContent), bm) }))
        .filter((x) => x.mt)
        .sort((a, b) => b.mt.score - a.mt.score || dist(a.m) - dist(b.m));
      if (scored.length) return scored[0].m;
    }
    const head = (bm.fp || '').slice(0, 60);
    if (head.length >= 20) {
      c = same.filter((m) => fpOf(m).startsWith(head));
      if (c.length) return near(c);
    }
    return null;
  }

  // ===== Passage anchors =====
  // A passage bookmark stores its text plus where it was: the offset in the message and up to
  // CTX characters of text before and after it (all whitespace-free, so reflowed or re-rendered
  // markup still matches). Short or repeated text then resolves to the occurrence that was selected.
  const CTX = 32;

  // Whitespace-free text of a message, with a map from each character back to its DOM text node
  function textIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = [];
    let s = '';
    for (let n; (n = walker.nextNode());) {
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        if (!/\s/.test(v[i])) { s += v[i]; map.push([n, i]); }
      }
    }
    return { s, map };
  }

  // Context saved when a passage is bookmarked (range = the selection, inside msgEl)
  function quoteAnchor(msgEl, range) {
    const before = document.createRange();
    before.setStart(msgEl, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEnd(msgEl, msgEl.childNodes.length);
    const pre = strip(before.toString());
    const suf = strip(after.toString());
    return { qOffset: pre.length, qLen: strip(range.toString()).length, qPrefix: pre.slice(-CTX), qSuffix: suf.slice(0, CTX) };
  }

  // Best occurrence of a passage in whitespace-free text s: the one whose surrounding text matches
  // the saved context most, then the one closest to the saved offset. Bookmarks saved before
  // anchors existed have no context or offset and fall back to the first occurrence.
  function quoteMatch(s, bm) {
    const q = strip(bm.quote);
    if (!q) return null;
    const len = bm.qLen || q.length;
    let best = null;
    for (let at = s.indexOf(q); at >= 0; at = s.indexOf(q, at + 1)) {
      let score = 0;
      const p = bm.qPrefix || '';
      while (score < p.length && s[at - 1 - score] === p[p.length - 1 - score]) score++;
      const x = bm.qSuffix || '';
      const end = at + len;
      let k = 0;
      while (k < x.length && s[end + k] === x[k]) k++;
      score += k;
      const dist = Math.abs(at - (bm.qOffset ?? 0));
      if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { at, score, dist };
    }
    // long passages store only their first 500 characters; qLen covers the full selection
    return best && { ...best, len: Math.min(len, s.length - best.at) };
  }

  // DOM Range of a passage bookmark within its message
  function findQuoteRange(root, bm) {
    const { s, map } = textIndex(root);
    const mt = quoteMatch(s, bm);
    if (!mt) return null;
    const [sn, so] = map[mt.at];
    const [en, eo] = map[mt.at + mt.len - 1];
    const r = document.createRange();
    r.setStart(sn, so);
    r.setEnd(en, eo + 1);
    return r;
  }

  function getScroller(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return document.scrollingElement || document.documentElement;
  }
  const scrollerTop = (sc) => (sc === document.scrollingElement || sc === document.documentElement ? 0 : sc.getBoundingClientRect().top);

  function anchorOf(bm, m) {
    const range = bm.quote ? findQuoteRange(m.el, bm) : null;
    return { range, top: (range || m.el).getBoundingClientRect().top };
  }

  function jump(bm) {
    const m = locate(bm);
    if (!m) { loadAndJump(bm); return false; }
    if (loading) loading.cancel = true;
    const { range, top } = anchorOf(bm, m);
    const sc = getScroller(m.el);
    sc.scrollBy({ top: top - scrollerTop(sc) - JUMP_OFFSET, behavior: 'smooth' });
    flash(m.el, range);
    return true;
  }

  // Scroll toward a bookmark that isn't loaded until claude.ai renders it, then jump to it
  let loading = null;
  async function loadAndJump(bm) {
    if (loading) loading.cancel = true;
    const job = (loading = { cancel: false });
    const target = isKnown(bm) ? absPos(bm) : null;
    toast('Loading the conversation to find this bookmark…');
    let dir = 0;
    let stuck = 0;
    let flipped = false;
    let lastSig = '';
    for (let i = 0; i < 80 && !job.cancel; i++) {
      msgCache = null;
      const msgs = getMessages();
      if (locate(bm, msgs)) { loading = null; jump(bm); return; }
      if (!msgs.length) break;
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      // known position: go straight there; unknown: try earlier messages first, then later ones
      if (!dir) dir = target != null && last.abs != null && target > last.abs ? 1 : -1;
      const sig = `${keyOf(first.role, fpOf(first))}:${msgs.length}:${keyOf(last.role, fpOf(last))}`;
      stuck = sig === lastSig ? stuck + 1 : 0;
      lastSig = sig;
      if (stuck >= 4) { // nothing more loads in this direction (~3s without changes)
        if (target != null || flipped) break;
        dir = -dir; flipped = true; stuck = 0;
      }
      const sc = getScroller(first.el);
      (dir < 0 ? first.el : last.el).scrollIntoView({ block: dir < 0 ? 'start' : 'end' });
      sc.scrollBy(0, dir * sc.clientHeight * 0.9);
      await waitForPageChange(800);
    }
    if (loading === job) loading = null;
    if (!job.cancel) toast('Couldn’t find this message (it may have been edited or be on another branch)');
  }

  // Resolves shortly after the page (not our own UI) changes, or after ms
  function waitForPageChange(ms) {
    return new Promise((resolve) => {
      const done = () => { mo.disconnect(); clearTimeout(t); resolve(); };
      const mo = new MutationObserver((muts) => {
        if (muts.some((x) => !isOurs(x.target.nodeType === 1 ? x.target : x.target.parentElement))) setTimeout(done, 150);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(done, ms);
    });
  }

  function flash(el, range) {
    el.classList.add('cbm-flash');
    setTimeout(() => el.classList.remove('cbm-flash'), 1800);
    if (range && HL) {
      CSS.highlights.set('cbm-hit', new Highlight(range));
      clearTimeout(flash.t);
      flash.t = setTimeout(() => CSS.highlights.delete('cbm-hit'), 4000);
    }
  }

  // Previous / next bookmark
  function step(dir) {
    const msgs = getMessages();
    const list = state.items
      .map((bm) => ({ bm, m: locate(bm, msgs) }))
      .filter((x) => x.m)
      .map((x) => ({ ...x, y: anchorOf(x.bm, x.m).top }))
      .sort((a, b) => a.y - b.y);
    if (!list.length) { toast('This conversation has no bookmarks yet'); return; }
    const sc = getScroller(list[0].m.el);
    const line = scrollerTop(sc) + JUMP_OFFSET;
    const t = dir > 0 ? list.find((x) => x.y > line + 30) : [...list].reverse().find((x) => x.y < line - 30);
    if (!t) { toast(dir > 0 ? 'Already at the last bookmark' : 'Already at the first bookmark'); return; }
    jump(t.bm);
  }

  // ===== Add / remove =====
  async function addBookmark(m, passage = null) {
    if (!state.convId) { toast('Open a conversation first'); return; }
    const fp = fingerprint(m.el);
    const dup = state.items.some((b) => b.role === m.role && b.fp === fp && (passage
      ? b.quote && b.qOffset === passage.qOffset && b.qLen === passage.qLen
      : !b.quote));
    if (dup) { toast(passage ? 'This passage is already bookmarked' : 'This message is already bookmarked'); return; }
    const bm = {
      id: uid(), role: m.role, index: m.index, pos: m.abs ?? m.index, fp, quote: '',
      snippet: norm(m.el.textContent).slice(0, 160),
      note: '', groupId: null, createdAt: Date.now(),
      ...passage,
    };
    state.items.push(bm);
    await save();
    refreshMarks();
    setPanel(true);
    render();
    const input = panel.querySelector(`[data-id="${bm.id}"] .cbm-note`);
    if (input) input.focus();
    toast('Bookmark added — type a note now if you like');
  }

  async function removeBookmark(id) {
    state.items = state.items.filter((b) => b.id !== id);
    await save();
    refreshMarks();
    render();
  }

  // ===== Groups =====
  async function addGroup() {
    const g = { id: uid(), name: '', collapsed: false };
    state.groups.push(g);
    await save();
    render();
    const input = panel.querySelector(`[data-gid="${g.id}"] .cbm-group-name`);
    if (input) { input.focus(); input.scrollIntoView({ block: 'nearest' }); }
  }

  async function removeGroup(gid) {
    // Bookmarks in the group are kept and move to "Ungrouped"
    for (const b of state.items) if (b.groupId === gid) b.groupId = null;
    state.groups = state.groups.filter((g) => g.id !== gid);
    await save();
    render();
  }

  async function updateGroup(gid, patch) {
    const g = state.groups.find((x) => x.id === gid);
    if (!g) return;
    Object.assign(g, patch);
    await save();
  }

  // ===== View settings (shared by all conversations) =====
  // sortByPosition: show bookmarks in conversation order instead of the custom (dragged) order.
  // It only changes how lists are displayed; the custom order is kept and comes back when unchecked.
  const SETTINGS_KEY = 'cbm_settings';
  const settings = { sortByPosition: false };

  async function loadSettings() {
    if (!alive()) return;
    Object.assign(settings, (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
  }

  async function setSetting(key, value) {
    settings[key] = value;
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings } });
  }

  // Where a bookmark sits in the conversation: [message index, offset of the quote in that message]
  // (whole-message bookmarks come before passages from the same message)
  function positionKey(bm, msgs) {
    const m = locate(bm, msgs);
    let offset = -1;
    if (bm.quote) offset = (m && quoteMatch(strip(m.el.textContent), bm)?.at) ?? bm.qOffset ?? 0;
    return [absPos(bm, msgs), offset];
  }
  const comparePos = (ka, kb) => ka[0] - kb[0] || ka[1] - kb[1];

  // Items as they should be displayed under the current setting
  function inView(items, keys) {
    if (!settings.sortByPosition) return items;
    return [...items].sort((a, b) => comparePos(keys.get(a.id), keys.get(b.id)) || a.createdAt - b.createdAt);
  }

  // Move a bookmark into a group (null = ungrouped), before another bookmark (null = at the end)
  async function moveItem(id, groupId, beforeId) {
    const i = state.items.findIndex((b) => b.id === id);
    if (i < 0 || id === beforeId) return;
    const [bm] = state.items.splice(i, 1);
    bm.groupId = groupId;
    let at = beforeId ? state.items.findIndex((b) => b.id === beforeId) : -1;
    if (at < 0) {
      // after the last bookmark of the target group, keeping groups contiguous in the array
      at = state.items.reduce((last, b, j) => (b.groupId === groupId ? j + 1 : last), state.items.length);
    }
    state.items.splice(at, 0, bm);
    await save();
    render();
  }

  async function moveGroup(gid, beforeGid) {
    const i = state.groups.findIndex((g) => g.id === gid);
    if (i < 0 || gid === beforeGid) return;
    const [g] = state.groups.splice(i, 1);
    const at = beforeGid ? state.groups.findIndex((x) => x.id === beforeGid) : -1;
    state.groups.splice(at < 0 ? state.groups.length : at, 0, g);
    await save();
    render();
  }

  // ===== UI: floating button, selection button, panel, toast =====
  const hoverBtn = h('button', 'cbm-ui cbm-hover-btn', '🔖');
  const selBtn = h('button', 'cbm-ui cbm-sel-btn', '🔖 Bookmark selection');
  const tab = h('button', 'cbm-ui cbm-tab');
  const panel = h('div', 'cbm-ui cbm-panel');
  const toastEl = h('div', 'cbm-ui cbm-toast');
  [hoverBtn, selBtn, tab, panel, toastEl].forEach((e) => document.body.appendChild(e));

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  // --- Bookmark button shown when hovering over a message ---
  let hoverMsg = null, hideT = null, raf = false, lastTarget = null;
  function messageBookmarked(el) {
    const fp = fingerprint(el);
    return state.items.find((b) => !b.quote && b.fp === fp);
  }
  function placeHover() {
    if (!hoverMsg || !hoverMsg.isConnected) { hoverBtn.classList.remove('show'); return; }
    const r = hoverMsg.getBoundingClientRect();
    if (r.bottom < 40 || r.top > window.innerHeight - 28) { hoverBtn.classList.remove('show'); return; }
    // Prefer the message's top-right corner (kept below the page header); short messages center it vertically
    let y = Math.max(r.top + 4, 64);
    if (y > r.bottom - 28) y = Math.max(r.top + (r.height - 28) / 2, 8);
    let x = r.right + 6;
    if (x + 30 > window.innerWidth - 8) x = r.right - 34;
    hoverBtn.style.top = `${y}px`;
    hoverBtn.style.left = `${x}px`;
    hoverBtn.classList.add('show');
  }
  document.addEventListener('mousemove', (e) => {
    lastTarget = e.target;
    if (raf) return;
    raf = true;
    requestAnimationFrame(() => {
      raf = false;
      if (lastTarget === hoverBtn) { clearTimeout(hideT); return; }
      const msg = isOurs(lastTarget) ? null : topMessage(lastTarget);
      if (msg) {
        clearTimeout(hideT);
        if (msg !== hoverMsg) {
          hoverMsg = msg;
          const on = !!messageBookmarked(msg);
          hoverBtn.classList.toggle('on', on);
          hoverBtn.title = on ? 'Remove bookmark from this message' : 'Bookmark this message';
        }
        placeHover();
      } else if (hoverMsg) {
        clearTimeout(hideT);
        hideT = setTimeout(() => { hoverMsg = null; hoverBtn.classList.remove('show'); }, 350);
      }
    });
  }, { passive: true });
  window.addEventListener('scroll', () => { if (hoverMsg) placeHover(); selBtn.classList.remove('show'); }, { capture: true, passive: true });

  hoverBtn.addEventListener('click', async () => {
    if (!hoverMsg) return;
    const existing = messageBookmarked(hoverMsg);
    if (existing) {
      await removeBookmark(existing.id);
      toast('Bookmark removed');
    } else {
      const m = getMessages().find((x) => x.el === hoverMsg);
      if (m) await addBookmark(m);
    }
    hoverBtn.classList.toggle('on', !!messageBookmarked(hoverMsg));
  });

  // --- “Bookmark selection” button shown after selecting text ---
  document.addEventListener('mouseup', (e) => {
    if (isOurs(e.target)) return;
    setTimeout(() => {
      const sel = getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString() : '';
      if (!strip(text)) { selBtn.classList.remove('show'); return; }
      const range = sel.getRangeAt(0);
      const msg = topMessage(range.commonAncestorContainer);
      if (!msg) { selBtn.classList.remove('show'); return; }
      const r = range.getBoundingClientRect();
      selBtn.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 40)}px`;
      selBtn.style.left = `${Math.min(Math.max(r.left, 8), window.innerWidth - 120)}px`;
      selBtn._msg = msg;
      selBtn._text = text;
      selBtn._range = range.cloneRange();
      selBtn.classList.add('show');
    }, 10);
  });
  selBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  selBtn.addEventListener('click', async () => {
    selBtn.classList.remove('show');
    const m = getMessages().find((x) => x.el === selBtn._msg);
    const range = selBtn._range;
    if (m && range && m.el.contains(range.commonAncestorContainer)) {
      // quote = DOM text (what matching runs against); snippet = the text as the user saw it
      await addBookmark(m, {
        quote: norm(range.toString()).slice(0, 500),
        snippet: norm(selBtn._text).slice(0, 160),
        ...quoteAnchor(m.el, range),
      });
    }
    getSelection()?.removeAllRanges();
  });
  document.addEventListener('mousedown', (e) => { if (e.target !== selBtn) selBtn.classList.remove('show'); });

  // --- Side panel ---
  function setPanel(open) {
    panel.classList.toggle('open', open);
    tab.classList.toggle('hidden', open);
    try { localStorage.setItem(PANEL_PREF, open ? '1' : '0'); } catch {}
    if (open) render();
  }
  const togglePanel = () => setPanel(!panel.classList.contains('open'));
  tab.addEventListener('click', () => setPanel(true));

  function updateTab() {
    const n = state.items.length;
    tab.textContent = n ? `🔖 ${n}` : '🔖';
    tab.title = 'Open bookmarks panel (Alt+B)';
    tab.style.display = state.convId ? '' : 'none';
    if (!state.convId) panel.classList.remove('open');
  }

  function iconBtn(text, title, onclick) {
    const b = h('button', 'cbm-icon-btn', text);
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); onclick(e); };
    return b;
  }

  function textInput(cls, value, placeholder, onSave) {
    const input = h('input', cls);
    input.value = value || '';
    input.placeholder = placeholder;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    };
    input.onchange = () => onSave(input.value.trim());
    return input;
  }

  // '' | 'cbm-unloaded' (seen in this conversation but not in the page right now) | 'cbm-missing'
  function statusOf(bm, msgs) {
    if (locate(bm, msgs)) return '';
    return isKnown(bm) ? 'cbm-unloaded' : 'cbm-missing';
  }
  const STATUS_TITLE = {
    'cbm-unloaded': 'Not loaded in the page yet — click to load it and jump there',
    'cbm-missing': 'Not found in this conversation (edited, on another branch, or never loaded since this update) — click to search',
  };

  function renderItem(bm, status) {
    const item = h('div', 'cbm-item' + (status ? ` ${status}` : ''));
    item.dataset.id = bm.id;
    if (status) item.title = STATUS_TITLE[status];
    const top = h('div', 'cbm-row');
    const grip = h('span', 'cbm-grip', '⠿');
    top.append(grip);
    top.append(h('span', `cbm-role ${bm.role}`, bm.role === 'user' ? 'You' : 'Claude'));
    top.append(textInput('cbm-note', bm.note, 'Add a note…', async (v) => {
      const b = state.items.find((x) => x.id === bm.id);
      if (b) { b.note = v; await save(); }
    }));
    top.append(iconBtn('🗑', 'Delete bookmark', () => removeBookmark(bm.id)));
    item.append(top);
    item.append(h('div', 'cbm-snippet' + (bm.quote ? ' quote' : ''), bm.quote ? `“${bm.snippet}”` : bm.snippet));
    item.onclick = (e) => {
      if (drag.justDropped || isEditable(e.target) || e.target.closest('button')) return;
      jump(bm);
    };
    return item;
  }

  function renderItems(items, statuses, groupId) {
    const box = h('div', 'cbm-items');
    box.dataset.group = groupId || '';
    for (const bm of items) box.append(renderItem(bm, statuses.get(bm.id)));
    if (!items.length) box.append(h('div', 'cbm-drop-hint', groupId ? 'Drag bookmarks here' : 'Drag here to ungroup'));
    return box;
  }

  let viewKeys = new Map();
  function render() {
    updateTab();
    if (!panel.classList.contains('open') || drag.active) return;
    const msgs = getMessages();
    const statuses = new Map(state.items.map((b) => [b.id, statusOf(b, msgs)]));
    viewKeys = new Map(state.items.map((b) => [b.id, positionKey(b, msgs)]));
    const listScroll = panel.querySelector('.cbm-list')?.scrollTop || 0;

    panel.replaceChildren();
    const head = h('div', 'cbm-head');
    head.append(h('span', 'cbm-title', `🔖 Bookmarks (${state.items.length})`));
    const tools = h('div', 'cbm-tools');
    tools.append(iconBtn('＋ Group', 'New group', addGroup));
    tools.append(iconBtn('✕', 'Close (Alt+B)', () => setPanel(false)));
    head.append(tools);
    panel.append(head);

    if (state.items.length) {
      const bar = h('label', 'cbm-bar');
      bar.title = 'Checked: conversation order. Unchecked: your own order (drag to arrange).';
      const cb = h('input');
      cb.type = 'checkbox';
      cb.checked = settings.sortByPosition;
      cb.onchange = async () => { await setSetting('sortByPosition', cb.checked); render(); };
      bar.append(cb, h('span', null, 'Sort by position in conversation'));
      panel.append(bar);
    }

    const list = h('div', 'cbm-list');
    if (!state.items.length && !state.groups.length) {
      list.append(h('div', 'cbm-empty', 'Hover over a message and click 🔖, or select some text and click “Bookmark selection”.'));
    } else {
      // Ungrouped bookmarks always come first
      const loose = inView(state.items.filter((b) => !b.groupId), viewKeys);
      const ungrouped = h('section', 'cbm-section cbm-ungrouped' + (loose.length ? '' : ' empty'));
      ungrouped.append(renderItems(loose, statuses, null));
      list.append(ungrouped);

      for (const g of state.groups) {
        const items = inView(state.items.filter((b) => b.groupId === g.id), viewKeys);
        const sec = h('section', 'cbm-section cbm-group' + (g.collapsed ? ' collapsed' : ''));
        sec.dataset.gid = g.id;
        const gh = h('div', 'cbm-group-head');
        const grip = h('span', 'cbm-grip', '⠿');
        gh.append(grip);
        gh.append(iconBtn(g.collapsed ? '▸' : '▾', g.collapsed ? 'Expand' : 'Collapse', async () => {
          await updateGroup(g.id, { collapsed: !g.collapsed });
          render();
        }));
        gh.append(textInput('cbm-group-name', g.name, 'Group name', (v) => updateGroup(g.id, { name: v })));
        gh.append(h('span', 'cbm-count', String(items.length)));
        gh.append(iconBtn('🗑', 'Delete group (its bookmarks move to the top)', () => removeGroup(g.id)));
        sec.append(gh);
        if (!g.collapsed) sec.append(renderItems(items, statuses, g.id));
        list.append(sec);
      }
    }
    panel.append(list);
    list.scrollTop = listScroll;
    panel.append(h('div', 'cbm-foot', (settings.sortByPosition
      ? 'Sorted by position · drag to move between groups'
      : 'Drag to reorder') + ' · Alt+B toggle panel · Alt+↑/↓ previous/next'));
  }

  // ===== Drag and drop =====
  // Pointer-based (so claude.ai's file-drop overlay is never triggered). The dragged row floats
  // under the pointer as a "ghost", its original element stays in the list as a placeholder, and
  // the placeholder moves through the DOM while the other rows slide out of the way (FLIP animation).
  const drag = { active: false, pending: null, justDropped: false };
  const ANIM_MS = 170;
  const LOCK_PX = 14;
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

  // Drag starts anywhere on a bookmark or group header, except text fields and buttons
  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag.active || e.target.closest('input, textarea, button')) return;
    const item = e.target.closest('.cbm-item');
    const head = !item && e.target.closest('.cbm-group-head');
    if (!item && !head) return;
    e.preventDefault(); // no text selection while dragging
    if (document.activeElement && panel.contains(document.activeElement)) document.activeElement.blur();
    const kind = item ? 'item' : 'group';
    const el = item || head.closest('.cbm-group');
    drag.pending = { kind, el, id: kind === 'item' ? el.dataset.id : el.dataset.gid, x: e.clientX, y: e.clientY };
  });

  document.addEventListener('pointermove', (e) => {
    if (drag.dropping || (!drag.pending && !drag.active)) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.pending.x, e.clientY - drag.pending.y) < 5) return;
      startDrag(drag.pending);
    }
    e.preventDefault();
    drag.y = e.clientY;
    moveGhost();
    updatePlaceholder();
    autoScroll();
  });

  function startDrag(p) {
    const list = panel.querySelector('.cbm-list');
    const r = p.el.getBoundingClientRect();
    Object.assign(drag, p, { active: true, pending: null, list, into: null, lockY: null, offsetY: p.y - r.top });
    // Ghost: a copy of the row that follows the pointer
    const ghost = h('div', 'cbm-ui cbm-ghost');
    const clone = p.el.cloneNode(true);
    const srcInputs = p.el.querySelectorAll('input');
    clone.querySelectorAll('input').forEach((inp, i) => { inp.value = srcInputs[i]?.value || ''; });
    ghost.append(clone);
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
    document.body.append(ghost);
    drag.ghost = ghost;
    p.el.classList.add('cbm-placeholder');
    panel.classList.add('cbm-drag-' + p.kind);
    getSelection()?.removeAllRanges();
    measure();
  }

  function moveGhost() {
    const lr = drag.list.getBoundingClientRect();
    const h0 = drag.ghost.offsetHeight;
    // keep the ghost roughly inside the list area
    const top = Math.min(Math.max(drag.y - drag.offsetY, lr.top - h0 / 2), lr.bottom - h0 / 2);
    drag.ghost.style.top = `${top}px`;
  }

  // Elements that take part in the reorder animation
  const animated = () => [...drag.list.querySelectorAll('.cbm-section, .cbm-item, .cbm-drop-hint')];

  // Layout position inside the list (offsetTop ignores in-flight transforms, so hit-testing
  // doesn't jitter while rows are still animating). The list is the offsetParent of every row.
  const layoutTop = (el) => {
    let y = 0;
    for (let e = el; e && e !== drag.list; e = e.offsetParent) y += e.offsetTop;
    return y;
  };
  function measure() {
    drag.rects = new Map(animated().map((el) => {
      const top = layoutTop(el);
      return [el, { top, bottom: top + el.offsetHeight }];
    }));
  }

  // Move the placeholder in the DOM and animate everything that shifted (First-Last-Invert-Play)
  function flip(mutate) {
    const els = animated();
    const toLayout = drag.list.getBoundingClientRect().top - drag.list.scrollTop;
    const first = new Map(els.map((el) => [el, el.getBoundingClientRect().top])); // where it is on screen now
    mutate();
    const delta = new Map(els.map((el) => [el, first.get(el) - (toLayout + layoutTop(el))]));
    for (const el of els) {
      if (el === drag.el || drag.el.contains(el)) continue;
      // a row inside a section that also moved only needs the difference
      const parent = el.parentElement.closest('.cbm-section');
      const dy = delta.get(el) - (parent && parent !== drag.el ? delta.get(parent) || 0 : 0);
      if (Math.abs(dy) < 1 || REDUCED_MOTION.matches) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      el.getBoundingClientRect(); // commit the inverted position before animating back
      el.style.transition = `transform ${ANIM_MS}ms cubic-bezier(.2,.7,.3,1)`;
      el.style.transform = '';
    }
    measure();
    drag.lockY = drag.y - drag.list.getBoundingClientRect().top + drag.list.scrollTop;
  }

  function setInto(sec) {
    if (drag.into === sec) return;
    drag.into?.classList.remove('cbm-drop-into');
    drag.into = sec;
    sec?.classList.add('cbm-drop-into');
    drag.el.classList.toggle('cbm-placeholder-away', !!sec);
  }

  // Decide where the placeholder belongs for the current pointer position
  function updatePlaceholder() {
    const y = drag.y - drag.list.getBoundingClientRect().top + drag.list.scrollTop;
    const R = (el) => drag.rects.get(el);
    const mid = (el) => (R(el).top + R(el).bottom) / 2;
    // Hysteresis: right after the placeholder moves, the layout under the pointer shifts; wait for
    // the pointer to travel a bit before deciding again, and never move while over the placeholder.
    if (drag.lockY != null && Math.abs(y - drag.lockY) < LOCK_PX) return;
    drag.lockY = null;
    const slot = R(drag.el);
    if (!drag.into && slot && y >= slot.top && y < slot.bottom) return;

    if (drag.kind === 'group') {
      const groups = [...drag.list.querySelectorAll('.cbm-group')].filter((g) => g !== drag.el && R(g));
      const before = groups.find((g) => y < mid(g)) || null;
      if (drag.el.nextElementSibling === before || (!before && !drag.el.nextElementSibling)) return;
      flip(() => drag.list.insertBefore(drag.el, before));
      return;
    }

    // Item: find the section under the pointer (nearest one when between sections)
    const sections = [...drag.list.querySelectorAll('.cbm-section')].filter((s) => R(s));
    if (!sections.length) return;
    let sec = sections.find((s) => y >= R(s).top && y < R(s).bottom);
    if (!sec) sec = sections.reduce((a, s) => (Math.min(Math.abs(y - R(s).top), Math.abs(y - R(s).bottom)) < Math.min(Math.abs(y - R(a).top), Math.abs(y - R(a).bottom)) ? s : a));
    const box = sec.querySelector('.cbm-items');
    if (!box) { setInto(sec); return; } // collapsed group: drop at its end
    setInto(null);
    const items = [...box.querySelectorAll('.cbm-item')].filter((i) => i !== drag.el && R(i));
    const own = viewKeys.get(drag.id);
    const before = (settings.sortByPosition
      ? items.find((i) => comparePos(viewKeys.get(i.dataset.id), own) > 0)
      : items.find((i) => y < mid(i))) || null;
    if (drag.el.parentElement === box && (drag.el.nextElementSibling === before ||
        (!before && !drag.el.nextElementSibling?.classList.contains('cbm-item')))) return;
    flip(() => box.insertBefore(drag.el, before || box.querySelector('.cbm-drop-hint')));
  }

  // Scroll the list while dragging near its top or bottom edge
  function autoScroll() {
    cancelAnimationFrame(autoScroll.raf);
    if (!drag.active) return;
    const r = drag.list.getBoundingClientRect();
    const zone = 40;
    const dy = drag.y < r.top + zone ? -(r.top + zone - drag.y) : drag.y > r.bottom - zone ? drag.y - (r.bottom - zone) : 0;
    if (!dy) return;
    const before = drag.list.scrollTop;
    drag.list.scrollTop += dy / 3;
    if (drag.list.scrollTop === before) return;
    autoScroll.raf = requestAnimationFrame(() => { updatePlaceholder(); autoScroll(); });
  }

  function endDrag(commit) {
    if (drag.pending) { drag.pending = null; return; }
    if (!drag.active || drag.dropping) return;
    drag.dropping = true;
    cancelAnimationFrame(autoScroll.raf);
    const { kind, id, el, ghost, into } = drag;
    drag.justDropped = true;
    setTimeout(() => { drag.justDropped = false; }, 0);

    let target = null;
    if (commit && kind === 'item') {
      if (into) target = { group: into.dataset.gid, before: null };
      else {
        const group = el.closest('.cbm-section')?.dataset.gid || null;
        const next = el.nextElementSibling?.classList.contains('cbm-item') ? el.nextElementSibling : null;
        if (!settings.sortByPosition) target = { group, before: next ? next.dataset.id : null };
        // Sorted view: only a group change is a real move; keep the custom order otherwise
        else if (group !== (state.items.find((b) => b.id === id)?.groupId || null)) target = { group, before: null };
      }
    } else if (commit) {
      target = { before: el.nextElementSibling?.dataset.gid || null };
    }

    const finish = () => {
      ghost.remove();
      drag.active = false;
      drag.dropping = false;
      panel.classList.remove('cbm-drag-item', 'cbm-drag-group');
      into?.classList.remove('cbm-drop-into');
      if (!target) { render(); return; }
      if (kind === 'item') moveItem(id, target.group, target.before);
      else moveGroup(id, target.before);
    };
    if (!commit) { finish(); return; }
    // Let the ghost settle into its destination, then rebuild the panel from the saved state
    const dest = (into || el).getBoundingClientRect();
    ghost.classList.add('cbm-ghost-drop');
    Object.assign(ghost.style, { top: `${dest.top}px`, opacity: into ? '0' : '' });
    setTimeout(finish, ANIM_MS);
  }
  document.addEventListener('pointerup', () => endDrag(true));
  document.addEventListener('pointercancel', () => endDrag(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drag.active) { e.preventDefault(); e.stopPropagation(); endDrag(false); }
  }, true);
  window.addEventListener('blur', () => endDrag(false));

  // ===== Mark bookmarked messages and passages =====
  function refreshMarks() {
    const msgs = getMessages();
    const marked = new Set();
    const ranges = [];
    for (const bm of state.items) {
      const m = locate(bm, msgs);
      if (!m) continue;
      marked.add(m.el);
      if (bm.quote && HL) {
        const r = findQuoteRange(m.el, bm);
        if (r) ranges.push(r);
      }
    }
    for (const m of msgs) {
      const want = marked.has(m.el);
      if (m.el.classList.contains('cbm-marked') !== want) m.el.classList.toggle('cbm-marked', want);
    }
    if (HL) {
      if (ranges.length) CSS.highlights.set('cbm-quote', new Highlight(...ranges));
      else CSS.highlights.delete('cbm-quote');
    }
    const byId = new Map(state.items.map((b) => [b.id, b]));
    panel.querySelectorAll('.cbm-panel .cbm-item').forEach((el) => {
      const bm = byId.get(el.dataset.id);
      if (!bm) return;
      const s = statusOf(bm, msgs);
      el.classList.toggle('cbm-unloaded', s === 'cbm-unloaded');
      el.classList.toggle('cbm-missing', s === 'cbm-missing');
      if (s) el.title = STATUS_TITLE[s]; else el.removeAttribute('title');
    });
    updateTab();
  }

  // ===== Jumps requested from the popup (cross-conversation) =====
  async function tryPending() {
    if (!alive()) return;
    const p = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
    if (!p) return;
    if (Date.now() - p.ts > 60000) { chrome.storage.local.remove(PENDING_KEY); return; }
    if (p.convId !== getConvId()) return;
    const bm = state.items.find((b) => b.id === p.bmId);
    if (!bm || tryPending.busy) return;
    if (!locate(bm) && Date.now() - p.ts < 2500) { setTimeout(tryPending, 800); return; } // let the page load first
    tryPending.busy = true;
    await chrome.storage.local.remove(PENDING_KEY);
    tryPending.busy = false;
    setTimeout(() => jump(bm), 300); // jump() loads the message first if needed
  }

  // ===== Events: keyboard, storage sync, navigation, DOM changes =====
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyB') { e.preventDefault(); e.stopPropagation(); if (state.convId) togglePanel(); }
    else if ((e.code === 'ArrowDown' || e.code === 'ArrowUp') && !isEditable(e.target)) {
      e.preventDefault();
      step(e.code === 'ArrowDown' ? 1 : -1);
    }
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (state.convId && changes[convKey(state.convId)]) {
      const before = JSON.stringify([state.items, state.groups]);
      applyConv(changes[convKey(state.convId)].newValue);
      msgCache = null;
      refreshMarks();
      if (JSON.stringify([state.items, state.groups]) !== before && !panel.contains(document.activeElement)) render();
      tryPending();
    }
    if (changes[PENDING_KEY]?.newValue) tryPending();
    if (changes[SETTINGS_KEY]) {
      Object.assign(settings, changes[SETTINGS_KEY].newValue);
      if (!panel.contains(document.activeElement)) render();
    }
  });

  async function onNavigate() {
    await Promise.all([load(), loadSettings()]);
    msgCache = null;
    refreshMarks();
    render();
    tryPending();
  }

  let lastHref = location.href;
  setInterval(() => {
    if (!alive()) return;
    if (location.href !== lastHref) { lastHref = location.href; onNavigate(); }
  }, 700);

  let mutT = null;
  new MutationObserver((muts) => {
    if (muts.every((m) => isOurs(m.target.nodeType === 1 ? m.target : m.target.parentElement))) return;
    msgCache = null;
    clearTimeout(mutT);
    mutT = setTimeout(() => {
      if (!alive()) return;
      refreshMarks();
      tryPending();
      if (state.items.length && getTitle() !== lastSavedTitle && getTitle() !== 'Untitled conversation') save();
    }, 400);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  let initialOpen = false;
  try { initialOpen = localStorage.getItem(PANEL_PREF) === '1'; } catch {}
  onNavigate().then(() => { if (initialOpen && state.convId) setPanel(true); });
})();
