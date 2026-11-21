'use strict';

// The page is usually served over plain http on the LAN, where navigator.clipboard does not exist
// (it needs https or localhost). Fall back to selecting the text and execCommand('copy').
function copyText(pre) {
  const text = pre.textContent;
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(pre);
  sel.removeAllRanges();
  sel.addRange(range);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    sel.removeAllRanges();
    sel.addRange(range);
    return ok;
  } catch {
    return false;
  }
}
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const CATCHES = {
    mac: 'App Store apps are not covered: mas is not installed.',
    windows: 'Needs an admin PowerShell.',
    linux: 'System flatpaks and rpm-ostree may need one sudo step for polkit; the installer prints it.',
    dockge: 'Paste into Dockge as a new stack and Deploy.',
    umbrel: '',
  };
  let state = null;
  const openDetails = new Set();

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    return res.json();
  }

  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const ver = (it) => (it.current || it.latest ? `${esc(it.current || '?')} → ${esc(it.latest || '?')}` : '');

  // A machine updates only what it proposed: the page builds an approval of the machine's latest
  // report, the signer signs it, and the machine checks it against its own list.
  async function approve(m, only) {
    if (m.os === 'umbrel') return api('POST', `/api/machines/${m.id}/update`, only ? { id: only } : {});
    const { event } = await api('POST', `/api/machines/${m.id}/draft`, { only: only ? [only] : [] });
    const signed = await window.FleetSigner.signEvent(event);
    return api('POST', `/api/machines/${m.id}/approval`, { event: signed });
  }

  function itemRow(m, it) {
    const tags = [];
    let action = '';
    if (it.channel === 'dockge') {
      if (it.flags.local) tags.push('built locally');
      else if (it.flags.notRunning) tags.push('not running');
      else if (it.pinned) tags.push('pinned');
      else if (it.flags.checkFailed && !it.flags.update) tags.push('check failed');
      if (!it.pinned && !it.flags.local) for (const n of it.flags.majors || []) tags.push(`major ${n}`);
      if (!it.flags.local) {
        const mode = it.pinned ? 'compare' : 'pinned';
        action += `<button class="small plain" data-act="override" data-m="${m.id}" data-stack="${esc(it.name)}" data-mode="${mode}">${it.pinned ? 'Unpin' : 'Pin'}</button>`;
      }
    }
    if (it.askFirst) tags.push('ask first');
    if (it.channel === 'winget') {
      action += `<button class="small plain" data-act="askfirst" data-id="${esc(it.name)}" data-on="${it.askFirst ? '' : '1'}">${it.askFirst ? 'Overnight' : 'Ask first'}</button>`;
    }
    if (it.actionable) {
      action += it.queued
        ? `<button class="small" disabled>Approved</button>`
        : `<button class="small" data-act="one" data-m="${m.id}" data-id="${it.id}">Update</button>`;
    }
    const v = it.channel === 'dockge' && !it.flags.update ? '' : ver(it);
    return `<li><span class="title">${esc(it.title || it.name)}</span>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span class="ver">${v}</span>${action}</li>`;
  }

  function card(m) {
    const updates = m.items.filter((i) => i.actionable);
    const forAll = updates.filter((i) => i.inUpdateAll);
    const others = m.items.filter((i) => !i.actionable);
    const quiet = !updates.length && !m.needs.length;
    const waiting = m.approval && m.approval.waiting && !m.approval.only.length;
    const head = `<header><h2>${esc(m.name)}</h2><span class="muted">${esc(ago(m.lastSeen))}</span>${
      updates.length ? `<span class="count">${updates.length}</span>` : ''
    }${forAll.length ? `<button data-act="all" data-m="${m.id}" ${waiting ? 'disabled' : ''}>${waiting ? 'Approved' : 'Update all'}</button>` : ''}</header>`;
    const needs = m.needs.length ? `<ul class="needs">${m.needs.map((n) => `<li${n.detail ? ` title="${esc(n.detail)}"` : ''}>${esc(n.text)}</li>`).join('')}</ul>` : '';
    const det = (key, label, inner) =>
      `<details data-key="${m.id}:${key}"${openDetails.has(`${m.id}:${key}`) ? ' open' : ''}><summary>${label}</summary>${inner}</details>`;
    const list = updates.length ? det('u', `${updates.length} ${updates.length === 1 ? 'update' : 'updates'}`, `<ul class="items">${updates.map((i) => itemRow(m, i)).join('')}</ul>`) : '';
    const rest = others.length ? det('o', m.os === 'dockge' ? `Other stacks: ${others.length}` : `Held: ${others.length}`, `<ul class="items">${others.map((i) => itemRow(m, i)).join('')}</ul>`) : '';
    let tools = `<div class="machine-tools"><span class="muted">${esc(m.os)}${m.host ? `, ${esc(m.host)}` : ''}${m.address ? `, ${esc(m.address)}` : ''}</span></div>`;
    if (m.os === 'umbrel') {
      tools += `<form class="row umbrel-edit" data-m="${m.id}"><input name="url" placeholder="${esc(m.address || 'http://umbrel.local')}" autocomplete="off"><input name="token" type="password" placeholder="MCP token" autocomplete="off"><button class="small plain">Save</button></form>`;
      tools += `<div class="machine-tools"><button class="small plain" data-act="check" data-m="${m.id}">Check now</button></div>`;
    }
    if (m.uninstall) tools += `<p class="muted cmd-label">Uninstall</p><pre>${esc(m.uninstall)}</pre>`;
    tools += `<div class="machine-tools"><button class="small plain" data-act="remove" data-m="${m.id}" data-name="${esc(m.name)}">Remove</button></div>`;
    return `<section class="card${quiet ? ' quiet' : ''}" data-id="${m.id}">${head}${needs}${list}${rest}${det('t', 'Machine', tools)}</section>`;
  }

  function render() {
    if (!state) return;
    // Keep what someone is typing on an Umbrel card.
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.umbrel-edit')) return;
    $('#machines').innerHTML = state.machines.map(card).join('');
    $('#log').innerHTML = state.log.length
      ? state.log
          .slice(0, 100)
          .map(
            (e) =>
              `<li><span class="when">${esc(when(e.at))}</span><span class="what">${esc(e.machine)}: ${esc(e.title)} ${e.to ? esc(e.to) : ''}</span>${
                e.status !== 'installed' ? `<span class="tag" title="${esc(e.message)}">${esc(e.status)}</span>` : ''
              }${e.how === 'overnight' ? '<span class="tag">overnight</span>' : ''}</li>`
          )
          .join('')
      : '<li class="muted">Nothing yet</li>';
    $('#askfirst').innerHTML = state.askFirst
      .map((id) => `<li><span class="title">${esc(id)}</span><button class="small plain" data-act="askfirst" data-id="${esc(id)}" data-on="">Remove</button></li>`)
      .join('');
  }

  async function load() {
    try {
      state = await api('GET', '/api/state');
      render();
    } catch (e) {
      console.error(e);
    }
  }

  document.addEventListener(
    'toggle',
    (e) => {
      const k = e.target.dataset && e.target.dataset.key;
      if (!k) return;
      if (e.target.open) openDetails.add(k);
      else openDetails.delete(k);
    },
    true
  );

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const d = b.dataset;
    const m = d.m && state.machines.find((x) => x.id === d.m);
    try {
      if (d.act === 'all') await approve(m, null);
      else if (d.act === 'one') await approve(m, d.id);
      else if (d.act === 'askfirst') await api('POST', '/api/ask-first', { id: d.id, on: !!d.on });
      else if (d.act === 'override') await api('POST', `/api/machines/${d.m}/override`, { stack: d.stack, mode: d.mode });
      else if (d.act === 'check') await api('POST', `/api/machines/${d.m}/check`, {});
      else if (d.act === 'remove') {
        if (!confirm(`Remove ${d.name}?`)) return;
        await api('DELETE', `/api/machines/${d.m}`);
      } else if (d.act === 'copy') {
        b.textContent = copyText(b.parentElement.querySelector('pre')) ? 'Copied' : 'Select and copy';
        return;
      }
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target.closest('.umbrel-edit');
    if (!f) return;
    e.preventDefault();
    try {
      await api('POST', `/api/machines/${f.dataset.m}/umbrel`, { url: f.url.value, token: f.token.value });
      f.reset();
      document.activeElement.blur();
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  const addForm = $('#add-form');
  function showCatch() {
    $('#add-catch').textContent = CATCHES[addForm.os.value] || '';
    $('#umbrel-form').hidden = addForm.os.value !== 'umbrel';
  }
  addForm.os.addEventListener('change', showCatch);
  showCatch();

  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const os = addForm.os.value;
    const out = $('#added');
    try {
      if (os === 'umbrel') {
        const u = $('#umbrel-form');
        await api('POST', '/api/umbrels', { name: addForm.name.value || u.url.value.replace(/^https?:\/\//, ''), url: u.url.value, token: u.token.value });
        u.reset();
        out.hidden = true;
      } else {
        const r = await api('POST', '/api/joins', { os, name: addForm.name.value });
        out.innerHTML = `<pre>${esc(r.command)}</pre><button class="small" data-act="copy">Copy</button>`;
        out.hidden = false;
      }
      addForm.name.value = '';
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, 30000);
})();
