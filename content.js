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
    msgCache = top.map((el, index) => ({ el, index, role: userSet.has(el) ? 'user' : 'assistant' }));
    return msgCache;
  }

  // Find the message element that contains a node
  function topMessage(node) {
    if (!node || isOurs(node.nodeType === 1 ? node : node.parentElement)) return null;
    const m = getMessages().find((x) => x.el.contains(node));
    return m ? m.el : null;
  }
  const fpOf = (m) => (m.fp ??= fingerprint(m.el));

  // ===== Data =====
  // items: bookmarks in display order; each has groupId (null = ungrouped)
  // groups: [{ id, name, collapsed }] in display order
  const state = { convId: null, items: [], groups: [] };
  let lastSavedTitle = '';

  function applyConv(conv) {
    state.items = conv?.items || [];
    state.groups = conv?.groups || [];
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
        ordered: true, items: state.items, groups: state.groups,
      },
    });
  }

  // ===== Locate a bookmark's message =====
  function locate(bm, msgs = getMessages()) {
    const near = (arr) => arr.sort((a, b) => Math.abs(a.index - bm.index) - Math.abs(b.index - bm.index))[0];
    const same = msgs.filter((m) => m.role === bm.role);
    let c = same.filter((m) => fpOf(m) === bm.fp);
    if (c.length) return near(c);
    if (bm.quote) {
      const q = strip(bm.quote);
      c = msgs.filter((m) => strip(m.el.textContent).includes(q));
      if (c.length) return near(c);
    }
    const head = (bm.fp || '').slice(0, 60);
    if (head.length >= 20) {
      c = same.filter((m) => fpOf(m).startsWith(head));
      if (c.length) return near(c);
    }
    return null;
  }

  // Find the Range of quoted text within a message (ignoring whitespace differences)
  function findQuoteRange(root, quote) {
    const target = strip(quote);
    if (!target) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = [];
    let s = '';
    for (let n; (n = walker.nextNode());) {
      const t = n.nodeValue;
      for (let i = 0; i < t.length; i++) {
        if (!/\s/.test(t[i])) { s += t[i]; map.push([n, i]); }
      }
    }
    const at = s.indexOf(target);
    if (at < 0) return null;
    const [sn, so] = map[at];
    const [en, eo] = map[at + target.length - 1];
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
    const range = bm.quote ? findQuoteRange(m.el, bm.quote) : null;
    return { range, top: (range || m.el).getBoundingClientRect().top };
  }

  function jump(bm) {
    const m = locate(bm);
    if (!m) { toast('This message isn’t on the current page (it may have been edited, be on another branch, or not be loaded yet)'); return false; }
    const { range, top } = anchorOf(bm, m);
    const sc = getScroller(m.el);
    sc.scrollBy({ top: top - scrollerTop(sc) - JUMP_OFFSET, behavior: 'smooth' });
    flash(m.el, range);
    return true;
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
  async function addBookmark(m, quote = '') {
    if (!state.convId) { toast('Open a conversation first'); return; }
    const fp = fingerprint(m.el);
    quote = norm(quote).slice(0, 500);
    if (!quote && state.items.some((b) => !b.quote && b.role === m.role && b.fp === fp)) {
      toast('This message is already bookmarked');
      return;
    }
    const bm = {
      id: uid(), role: m.role, index: m.index, fp, quote,
      snippet: (quote || norm(m.el.textContent)).slice(0, 160),
      note: '', groupId: null, createdAt: Date.now(),
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

  // Sort bookmarks inside each group by where they appear in the conversation
  async function sortByPosition() {
    const msgs = getMessages();
    const pos = new Map(state.items.map((b) => {
      const m = locate(b, msgs);
      return [b.id, m ? m.index : b.index];
    }));
    state.items.sort((a, b) => pos.get(a.id) - pos.get(b.id) || a.createdAt - b.createdAt);
    await save();
    render();
    toast('Sorted by position in the conversation');
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
      if (strip(text).length < 2) { selBtn.classList.remove('show'); return; }
      const range = sel.getRangeAt(0);
      const msg = topMessage(range.commonAncestorContainer);
      if (!msg) { selBtn.classList.remove('show'); return; }
      const r = range.getBoundingClientRect();
      selBtn.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 40)}px`;
      selBtn.style.left = `${Math.min(Math.max(r.left, 8), window.innerWidth - 120)}px`;
      selBtn._msg = msg;
      selBtn._text = text;
      selBtn.classList.add('show');
    }, 10);
  });
  selBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  selBtn.addEventListener('click', async () => {
    selBtn.classList.remove('show');
    const m = getMessages().find((x) => x.el === selBtn._msg);
    if (m) await addBookmark(m, selBtn._text);
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

  function renderItem(bm, missing) {
    const item = h('div', 'cbm-item' + (missing ? ' cbm-missing' : ''));
    item.dataset.id = bm.id;
    const top = h('div', 'cbm-row');
    const grip = h('span', 'cbm-grip', '⠿');
    grip.title = 'Drag to reorder or move to a group';
    grip.dataset.drag = 'item';
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
      if (drag.justDropped || isEditable(e.target) || e.target.closest('button, .cbm-grip')) return;
      jump(bm);
    };
    return item;
  }

  function renderItems(items, missingIds, groupId) {
    const box = h('div', 'cbm-items');
    box.dataset.group = groupId || '';
    for (const bm of items) box.append(renderItem(bm, missingIds.has(bm.id)));
    if (!items.length) box.append(h('div', 'cbm-drop-hint', groupId ? 'Drag bookmarks here' : 'Drag here to ungroup'));
    return box;
  }

  function render() {
    updateTab();
    if (!panel.classList.contains('open') || drag.active) return;
    const msgs = getMessages();
    const missing = new Set(state.items.filter((b) => !locate(b, msgs)).map((b) => b.id));
    const listScroll = panel.querySelector('.cbm-list')?.scrollTop || 0;

    panel.replaceChildren();
    const head = h('div', 'cbm-head');
    head.append(h('span', 'cbm-title', `🔖 Bookmarks (${state.items.length})`));
    const tools = h('div', 'cbm-tools');
    tools.append(iconBtn('＋ Group', 'New group', addGroup));
    tools.append(iconBtn('⇅', 'Sort each group by position in the conversation', sortByPosition));
    tools.append(iconBtn('✕', 'Close (Alt+B)', () => setPanel(false)));
    head.append(tools);
    panel.append(head);

    const list = h('div', 'cbm-list');
    if (!state.items.length && !state.groups.length) {
      list.append(h('div', 'cbm-empty', 'Hover over a message and click 🔖, or select some text and click “Bookmark selection”.'));
    } else {
      // Ungrouped bookmarks always come first
      const loose = state.items.filter((b) => !b.groupId);
      const ungrouped = h('section', 'cbm-section cbm-ungrouped' + (loose.length ? '' : ' empty'));
      ungrouped.append(renderItems(loose, missing, null));
      list.append(ungrouped);

      for (const g of state.groups) {
        const items = state.items.filter((b) => b.groupId === g.id);
        const sec = h('section', 'cbm-section cbm-group' + (g.collapsed ? ' collapsed' : ''));
        sec.dataset.gid = g.id;
        const gh = h('div', 'cbm-group-head');
        const grip = h('span', 'cbm-grip', '⠿');
        grip.title = 'Drag to reorder groups';
        grip.dataset.drag = 'group';
        gh.append(grip);
        gh.append(iconBtn(g.collapsed ? '▸' : '▾', g.collapsed ? 'Expand' : 'Collapse', async () => {
          await updateGroup(g.id, { collapsed: !g.collapsed });
          render();
        }));
        gh.append(textInput('cbm-group-name', g.name, 'Group name', (v) => updateGroup(g.id, { name: v })));
        gh.append(h('span', 'cbm-count', String(items.length)));
        gh.append(iconBtn('🗑', 'Delete group (its bookmarks move to the top)', () => removeGroup(g.id)));
        sec.append(gh);
        if (!g.collapsed) sec.append(renderItems(items, missing, g.id));
        list.append(sec);
      }
    }
    panel.append(list);
    list.scrollTop = listScroll;
    panel.append(h('div', 'cbm-foot', 'Drag ⠿ to reorder · Alt+B toggle panel · Alt+↑/↓ previous/next'));
  }

  // ===== Drag and drop (pointer-based, so claude.ai's file-drop handling is never triggered) =====
  const drag = { active: false, pending: null, justDropped: false };
  const dropLine = h('div', 'cbm-drop-line');

  panel.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.cbm-grip');
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const kind = grip.dataset.drag;
    const el = grip.closest(kind === 'item' ? '.cbm-item' : '.cbm-group');
    drag.pending = { kind, el, id: kind === 'item' ? el.dataset.id : el.dataset.gid, x: e.clientX, y: e.clientY };
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag.pending && !drag.active) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.pending.x, e.clientY - drag.pending.y) < 4) return;
      Object.assign(drag, drag.pending, { active: true, pending: null, target: null });
      drag.el.classList.add('cbm-dragging');
      panel.classList.add('cbm-drag-' + drag.kind);
      panel.querySelector('.cbm-list').append(dropLine);
      getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    drag.y = e.clientY;
    updateDropTarget(e.clientX, e.clientY);
    autoScroll();
  });

  function endDrag(commit) {
    if (drag.pending) { drag.pending = null; return; }
    if (!drag.active) return;
    const { kind, id, target, el } = drag;
    drag.active = false;
    el.classList.remove('cbm-dragging');
    panel.classList.remove('cbm-drag-item', 'cbm-drag-group');
    dropLine.remove();
    panel.querySelectorAll('.cbm-drop-into').forEach((x) => x.classList.remove('cbm-drop-into'));
    drag.justDropped = true;
    setTimeout(() => { drag.justDropped = false; }, 0);
    if (!commit || !target) { render(); return; }
    if (kind === 'item') moveItem(id, target.group, target.before);
    else moveGroup(id, target.before);
  }
  document.addEventListener('pointerup', () => endDrag(true));
  document.addEventListener('pointercancel', () => endDrag(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag.active) endDrag(false); }, true);

  // Pick the insertion point for the pointer position and draw the indicator line
  function updateDropTarget(x, y) {
    const list = panel.querySelector('.cbm-list');
    panel.querySelectorAll('.cbm-drop-into').forEach((el) => el.classList.remove('cbm-drop-into'));
    let line = null;

    if (drag.kind === 'group') {
      const secs = [...list.querySelectorAll('.cbm-group')].filter((s) => s !== drag.el);
      const before = secs.find((s) => { const r = s.getBoundingClientRect(); return y < r.top + r.height / 2; });
      drag.target = { before: before ? before.dataset.gid : null };
      const ref = before || secs[secs.length - 1];
      if (ref) line = before ? ref.getBoundingClientRect().top : ref.getBoundingClientRect().bottom;
    } else {
      const sections = [...list.querySelectorAll('.cbm-section')];
      // The section under the pointer; above/below everything snaps to the first/last section
      let sec = sections.find((s) => { const r = s.getBoundingClientRect(); return y >= r.top && y < r.bottom; });
      if (!sec) sec = y < list.getBoundingClientRect().top + 40 ? sections[0] : sections[sections.length - 1];
      if (!sec) return;
      const gid = sec.dataset.gid || null;
      const box = sec.querySelector('.cbm-items');
      if (!box) {
        // Collapsed group: drop at its end
        drag.target = { group: gid, before: null };
        sec.classList.add('cbm-drop-into');
      } else {
        const items = [...box.querySelectorAll('.cbm-item')].filter((i) => i !== drag.el);
        const before = items.find((i) => { const r = i.getBoundingClientRect(); return y < r.top + r.height / 2; });
        drag.target = { group: gid, before: before ? before.dataset.id : null };
        if (before) line = before.getBoundingClientRect().top;
        else if (items.length) line = items[items.length - 1].getBoundingClientRect().bottom;
        else { sec.classList.add('cbm-drop-into'); }
      }
    }

    if (line == null) { dropLine.style.display = 'none'; return; }
    const lr = list.getBoundingClientRect();
    dropLine.style.display = 'block';
    dropLine.style.top = `${line - lr.top + list.scrollTop - 1}px`;
  }

  // Scroll the list while dragging near its top or bottom edge
  function autoScroll() {
    if (!drag.active) return;
    const list = panel.querySelector('.cbm-list');
    const r = list.getBoundingClientRect();
    const zone = 36;
    const dy = drag.y < r.top + zone ? -(r.top + zone - drag.y) : drag.y > r.bottom - zone ? drag.y - (r.bottom - zone) : 0;
    if (!dy) return;
    list.scrollTop += dy / 3;
    cancelAnimationFrame(autoScroll.raf);
    autoScroll.raf = requestAnimationFrame(() => { updateDropTarget(0, drag.y); autoScroll(); });
  }

  // ===== Mark bookmarked messages and passages =====
  function refreshMarks() {
    const msgs = getMessages();
    const marked = new Set();
    const ranges = [];
    const missing = new Set();
    for (const bm of state.items) {
      const m = locate(bm, msgs);
      if (!m) { missing.add(bm.id); continue; }
      marked.add(m.el);
      if (bm.quote && HL) {
        const r = findQuoteRange(m.el, bm.quote);
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
    panel.querySelectorAll('.cbm-item').forEach((el) => el.classList.toggle('cbm-missing', missing.has(el.dataset.id)));
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
    if (!bm || !locate(bm)) return; // message may not be loaded yet; wait for the next DOM change
    await chrome.storage.local.remove(PENDING_KEY);
    setTimeout(() => jump(bm), 300);
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
      applyConv(changes[convKey(state.convId)].newValue);
      refreshMarks();
      if (!panel.contains(document.activeElement)) render();
      tryPending();
    }
    if (changes[PENDING_KEY]?.newValue) tryPending();
  });

  async function onNavigate() {
    await load();
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
