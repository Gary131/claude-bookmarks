// Claude Conversation Bookmarks — popup / manager page
const isPage = new URLSearchParams(location.search).has('page');
if (isPage) document.body.classList.add('page');

const PENDING_KEY = 'cbm_pending';
const $ = (s) => document.querySelector(s);
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function getSettings() {
  return (await chrome.storage.local.get('cbm_settings')).cbm_settings || {};
}

async function getAll() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('conv:'))
    .map(([, v]) => v)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

async function render() {
  const q = norm($('#search').value).toLowerCase();
  const [convs, settings] = await Promise.all([getAll(), getSettings()]);
  const list = $('#list');
  list.replaceChildren();

  let shown = 0;
  for (const conv of convs) {
    const titleHit = (conv.title || '').toLowerCase().includes(q);
    const groups = conv.groups || [];
    const gname = new Map(groups.map((g) => [g.id, g.name || 'Untitled group']));
    const all = [...(conv.items || [])];
    // Same setting as the side panel's "Sort by position in conversation" checkbox
    if (!conv.ordered || settings.sortByPosition) all.sort((a, b) => (a.pos ?? a.index) - (b.pos ?? b.index) || (a.qOffset ?? -1) - (b.qOffset ?? -1) || a.createdAt - b.createdAt);
    // Same order as the side panel: ungrouped first, then each group in order
    const ordered = [
      ...all.filter((b) => !gname.has(b.groupId)),
      ...groups.flatMap((g) => all.filter((b) => b.groupId === g.id)),
    ];
    const items = ordered.filter((b) => !q || titleHit ||
      `${b.note} ${b.snippet} ${b.quote} ${gname.get(b.groupId) || ''}`.toLowerCase().includes(q));
    if (!items.length) continue;
    shown++;

    const box = h('section', 'conv');
    const head = h('div', 'conv-head');
    head.title = 'Open this conversation';
    head.append(h('span', 'conv-title', conv.title || 'Untitled conversation'));
    head.append(h('span', 'conv-meta', `${items.length} · ${fmtDate(conv.updatedAt)}`));
    head.onclick = () => openConv(conv.id, null);
    box.append(head);

    let lastGroup;
    for (const b of items) {
      const g = gname.has(b.groupId) ? b.groupId : null;
      if (g !== lastGroup && g) box.append(h('div', 'group-label', gname.get(g)));
      lastGroup = g;
      const row = h('div', 'bm');
      row.append(h('span', `role ${b.role}`, b.role === 'user' ? 'You' : 'Claude'));
      const body = h('div', 'bm-body');
      if (b.note) body.append(h('div', 'bm-note', b.note));
      body.append(h('div', 'bm-snippet' + (b.quote ? ' quote' : ''), b.quote ? `“${b.snippet}”` : b.snippet));
      row.append(body);
      const del = h('button', 'del', '✕');
      del.title = 'Delete bookmark';
      del.onclick = async (e) => {
        e.stopPropagation();
        conv.items = conv.items.filter((x) => x.id !== b.id);
        const key = `conv:${conv.id}`;
        if (conv.items.length || (conv.groups || []).length) await chrome.storage.local.set({ [key]: { ...conv, updatedAt: Date.now() } });
        else await chrome.storage.local.remove(key);
        render();
      };
      row.append(del);
      row.onclick = () => openConv(conv.id, b.id);
      box.append(row);
    }
    list.append(box);
  }

  if (!shown) {
    list.append(h('div', 'empty', q
      ? 'No matching bookmarks'
      : 'No bookmarks yet.\nIn a claude.ai conversation, hover over a message and click 🔖,\nor select some text and click “Bookmark selection”.'));
    list.lastChild.style.whiteSpace = 'pre-line';
  }
}

async function openConv(convId, bmId) {
  if (bmId) await chrome.storage.local.set({ [PENDING_KEY]: { convId, bmId, ts: Date.now() } });
  const url = `https://claude.ai/chat/${convId}`;
  const sameConv = (t) => t.url && t.url.includes(`/chat/${convId}`);

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.startsWith('https://claude.ai/') || isPage) {
    const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    tab = claudeTabs.find(sameConv) || claudeTabs[0] || null;
  }
  if (!tab) {
    await chrome.tabs.create({ url });
  } else {
    if (!sameConv(tab)) await chrome.tabs.update(tab.id, { url });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  if (!isPage) window.close();
}

// Export
$('#export').onclick = async () => {
  const data = { app: 'claude-bookmarks', version: 1, exportedAt: new Date().toISOString(), conversations: await getAll() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `claude-bookmarks-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Import (the popup may close when the file picker opens, so do it in a tab instead)
$('#import').onclick = () => {
  if (!isPage) {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?page=1&import=1') });
    window.close();
    return;
  }
  $('#file').click();
};
$('#file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const convs = data.conversations || [];
    const existing = await chrome.storage.local.get(convs.map((c) => `conv:${c.id}`));
    const updates = {};
    let added = 0;
    for (const c of convs) {
      if (!c.id || !Array.isArray(c.items)) continue;
      const key = `conv:${c.id}`;
      const cur = existing[key] || { ...c, items: [], groups: [] };
      // Files from older versions have no manual order: use conversation order
      const inOrder = (conv) => (conv.ordered ? [...conv.items] : [...conv.items].sort((a, b) => a.index - b.index));
      const ids = new Set(cur.items.map((b) => b.id));
      const fresh = inOrder(c).filter((b) => !ids.has(b.id));
      const gids = new Set((cur.groups || []).map((g) => g.id));
      const groups = [...(cur.groups || []), ...(c.groups || []).filter((g) => !gids.has(g.id))];
      added += fresh.length;
      updates[key] = {
        ...cur, title: cur.title || c.title, ordered: true, groups,
        items: [...inOrder(cur), ...fresh], updatedAt: Math.max(cur.updatedAt || 0, c.updatedAt || 0),
      };
    }
    await chrome.storage.local.set(updates);
    alert(`Import complete: ${added} bookmark(s) added`);
    render();
  } catch (err) {
    alert('Import failed: invalid file format\n' + err.message);
  }
  e.target.value = '';
};

$('#search').addEventListener('input', render);
chrome.storage.onChanged.addListener(render);
render();
if (isPage && new URLSearchParams(location.search).has('import')) $('#import').focus();
