/* ATLAS Enterprise AI — UI Controller
   Integrates Chat AI+ design with FastAPI backend.
   State persists in localStorage. API calls go to FastAPI endpoints. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'atlas.v1', SKEY = 'atlas.settings';
  const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* ---------- API helper ---------- */
  const api = async (path, options = {}) => {
    const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await res.json();
    if (!res.ok) throw Error(data.detail || 'Request failed');
    return data;
  };

  /* ---------- State ---------- */
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch (e) { state = null; }
  if (!state || !Array.isArray(state.chats)) state = { chats: [], activeId: null };
  let settings = { name: 'Atlas User', delay: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY)) || {}); } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) {} };
  const active = () => state.chats.find(c => c.id === state.activeId);
  let query = '', renamingId = null, pending = false;

  /* ---------- Helpers ---------- */
  let toastT;
  const toast = msg => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2500); };
  const plain = html => { const d = document.createElement('div'); d.innerHTML = html; return d.innerText || d.textContent; };

  function modal(title, bodyHTML, buttons) {
    $('modalTitle').textContent = title; $('modalBody').innerHTML = bodyHTML;
    const a = $('modalActions'); a.innerHTML = '';
    buttons.forEach(b => {
      const el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = () => { if (!b.keep && b.fn?.() === false) return; if (!b.keep) closeModal(); };
      a.appendChild(el);
    });
    $('modal').hidden = false;
  }
  const closeModal = () => { $('modal').hidden = true; };
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  /* ---------- View switching (workspace tabs) ---------- */
  function view(name) {
    ['chat', 'docs', 'approval', 'admin'].forEach(x => {
      $(x + 'View').classList.toggle('hidden', x !== name);
      $(x + 'Tab').classList.toggle('active', x === name);
    });
    $('heading').textContent = {
      chat: "Ask your organization's knowledge",
      docs: 'Document management',
      approval: 'Approval requests',
      admin: 'Operational overview'
    }[name];
    if (name === 'docs') loadDocs();
    if (name === 'admin') loadMetrics();
    if (name === 'approval') loadApprovals();
  }
  $('chatTab').onclick = () => view('chat');
  $('docsTab').onclick = () => view('docs');
  $('adminTab').onclick = () => view('admin');
  $('approvalTab').onclick = () => view('approval');
  $('refreshApprovals').onclick = loadApprovals;

  /* ---------- Sidebar: Chat List ---------- */
  function renderList() {
    const list = $('chatList'); list.innerHTML = '';
    const q = query.trim().toLowerCase();
    const items = state.chats.filter(c => c.title.toLowerCase().includes(q));
    if (!items.length) {
      list.innerHTML = `<div class="empty">${state.chats.length ? 'No matching chats' : 'No conversations yet'}</div>`;
      return;
    }
    items.forEach(c => list.appendChild(chatItem(c)));
  }

  function chatItem(c) {
    const el = document.createElement('div');
    el.className = 'chat-item' + (c.id === state.activeId ? ' active' : '');
    el.innerHTML = `<i class="fa-regular fa-message"></i>` +
      (renamingId === c.id
        ? `<input class="rename-in" value="${esc(c.title)}">`
        : `<span class="t">${esc(c.title)}</span>`) +
      `<div class="item-actions"><button data-a="del" title="Delete"><i class="fa-regular fa-trash-can"></i></button><button data-a="ren" title="Rename"><i class="fa-regular fa-pen-to-square"></i></button><span class="indicator"></span></div>`;

    const inp = el.querySelector('.rename-in');
    if (inp) {
      setTimeout(() => { inp.focus(); inp.select(); });
      const done = ok => { if (ok && inp.value.trim()) c.title = inp.value.trim(); renamingId = null; save(); renderList(); };
      inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      inp.onblur = () => done(true); inp.onclick = e => e.stopPropagation();
    }
    el.onclick = e => {
      const b = e.target.closest('button');
      if (b?.dataset.a === 'del') { e.stopPropagation(); return deleteChat(c.id); }
      if (b?.dataset.a === 'ren') { e.stopPropagation(); renamingId = c.id; return renderList(); }
      state.activeId = c.id; save(); renderList(); renderChat(); $('sidebar').classList.remove('open');
    };
    return el;
  }

  function deleteChat(id) {
    modal('Delete conversation?', '<p>This conversation will be permanently removed.</p>', [
      { label: 'Cancel' },
      { label: 'Delete', cls: 'danger', fn: () => {
        state.chats = state.chats.filter(c => c.id !== id);
        if (state.activeId === id) state.activeId = state.chats[0]?.id || null;
        save(); renderList(); renderChat(); toast('Conversation deleted');
      }}
    ]);
  }

  function newChat() {
    const existing = state.chats.find(c => !c.messages.length);
    if (existing) { state.activeId = existing.id; }
    else {
      const c = { id: crypto.randomUUID(), title: 'New conversation', messages: [], conversationId: crypto.randomUUID() };
      state.chats.unshift(c);
      state.activeId = c.id;
    }
    save(); renderList(); renderChat(); view('chat'); $('msgInput').focus(); $('sidebar').classList.remove('open');
  }

  /* ---------- Chat Rendering ---------- */
  function renderChat(showTyping) {
    const col = $('chatCol'), c = active();
    if (!c || !c.messages.length) {
      col.innerHTML = `<div class="welcome">
        <div class="spark">✦</div>
        <h2>What can I help you find?</h2>
        <p>Ask questions about your approved documents. Every answer includes its evidence.</p>
        <div class="suggestions">
          <button data-q="What is our leave policy?">Leave policy ↗</button>
          <button data-q="Summarize the onboarding process">Onboarding ↗</button>
          <button data-q="What are the IT security rules?">IT security ↗</button>
        </div>
      </div>`;
      // Bind suggestion buttons
      col.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
        $('msgInput').value = b.dataset.q; $('msgInput').focus();
      });
      return;
    }
    let html = '';
    c.messages.forEach((m, i) => {
      if (m.role === 'user') {
        html += `<div class="msg-block"><div class="msg-user"><span class="user-icon"><i class="fa-solid fa-user"></i></span><span class="txt">${esc(m.text)}</span><button class="icon-circle" data-a="edit" data-i="${i}" title="Edit"><i class="fa-regular fa-pen-to-square"></i></button></div>`;
      } else {
        const last = i === c.messages.length - 1;
        // Build AI body content
        let bodyContent = '';
        if (m.text) bodyContent += `<p>${esc(m.text)}</p>`;
        if (m.html) bodyContent += m.html;

        // Sources
        if (m.sources && m.sources.length) {
          bodyContent += '<div class="sources">';
          m.sources.forEach(s => {
            bodyContent += `<details><summary>[${esc(String(s.index))}] ${esc(s.title)} — page ${esc(String(s.page))}</summary><p>${esc(s.excerpt)}</p></details>`;
          });
          bodyContent += '</div>';
        }

        // Status badges
        if (m.status === 'pending_approval') {
          bodyContent += `<p class="status-pending"><i class="fa-solid fa-clock"></i> Pending approval — check the Approvals tab</p>`;
        }
        if (m.status === 'guardrail_blocked') {
          bodyContent += `<p class="status-blocked"><i class="fa-solid fa-shield-halved"></i> Blocked by guardrail</p>`;
        }

        html += `<div class="ai-label">ATLAS AI <i class="fa-regular fa-circle-check" style="font-size:9px"></i></div>
        <div class="ai-body">${bodyContent}</div>
        <div class="actions"><div class="act-group"><div class="act-pill">
          <button data-a="like" data-i="${i}" class="${m.liked ? 'on' : ''}" title="Like"><i class="fa-${m.liked ? 'solid' : 'regular'} fa-thumbs-up"></i></button><span class="sep"></span>
          <button data-a="dislike" data-i="${i}" class="${m.disliked ? 'on' : ''}" title="Dislike"><i class="fa-${m.disliked ? 'solid' : 'regular'} fa-thumbs-down"></i></button><span class="sep"></span>
          <button data-a="copy" data-i="${i}" title="Copy"><i class="fa-regular fa-copy"></i></button></div>
          <div class="more" style="display:flex;align-items:center;justify-content:center"><button data-a="more" data-i="${i}" style="width:28px;height:28px" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button></div></div>
          <button class="btn" data-a="feedback" data-i="${i}"><i class="fa-regular fa-thumbs-up"></i> Helpful</button></div>`;
        if (!last) html += '<div class="divider"></div>';
        html += '</div>';
      }
    });
    if (showTyping) html += `<div class="ai-label">ATLAS AI</div><div class="typing"><i></i><i></i><i></i></div>`;
    col.innerHTML = html;
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  }

  /* ---------- Send message to backend ---------- */
  async function send() {
    const inp = $('msgInput'), text = inp.value.trim();
    if (!text || pending) return;

    // Ensure active chat exists
    if (!active()) {
      const c = { id: crypto.randomUUID(), title: 'New conversation', messages: [], conversationId: crypto.randomUUID() };
      state.chats.unshift(c);
      state.activeId = c.id;
    }
    const c = active();
    if (!c.messages.length) c.title = text.length > 30 ? text.slice(0, 30) + '...' : text;
    c.messages.push({ role: 'user', text });
    inp.value = '';
    save(); renderList();

    // Show typing indicator
    pending = true;
    renderChat(true);

    try {
      const r = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ question: text, conversation_id: c.conversationId || null })
      });

      // Store conversation_id from backend
      if (r.conversation_id) c.conversationId = r.conversation_id;

      const aiMsg = { role: 'ai', text: r.answer, sources: r.sources || [], status: r.status || 'ok' };
      c.messages.push(aiMsg);
      pending = false;
      save();
      renderChat();

      // If pending approval, show link
      if (r.status === 'pending_approval' && r.approval_id) {
        c.messages[c.messages.length - 1].approvalId = r.approval_id;
        save();
      }
    } catch (err) {
      const errMsg = { role: 'ai', text: 'Error: ' + err.message, sources: [], status: 'error' };
      c.messages.push(errMsg);
      pending = false;
      save();
      renderChat();
    }
  }

  /* ---------- Chat action handlers ---------- */
  $('chatCol').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]');
    if (!b) { document.querySelectorAll('.menu').forEach(m => m.remove()); return; }
    const c = active();
    if (!c) return;
    const i = +b.dataset.i, m = c.messages[i], a = b.dataset.a;
    document.querySelectorAll('.menu').forEach(x => x.remove());

    if (a === 'like') { m.liked = !m.liked; m.disliked = false; save(); renderChat(); sendFeedback(1); }
    else if (a === 'dislike') { m.disliked = !m.disliked; m.liked = false; save(); renderChat(); sendFeedback(-1); }
    else if (a === 'copy') copy(m.text || plain(m.html || ''));
    else if (a === 'edit') { $('msgInput').value = m.text; $('msgInput').focus(); toast('Edit your message and press send'); }
    else if (a === 'feedback') { sendFeedback(1); }
    else if (a === 'more') {
      const menu = document.createElement('div'); menu.className = 'menu';
      menu.innerHTML = '<button data-m="copy">Copy text</button><button data-m="del">Delete reply</button>';
      b.parentElement.appendChild(menu);
      menu.onclick = ev => {
        ev.stopPropagation(); const k = ev.target.dataset.m;
        if (k === 'copy') copy(m.text || plain(m.html || ''));
        if (k === 'del') { c.messages.splice(i - 1, 2); save(); renderChat(); toast('Reply removed'); }
        menu.remove();
      };
    }
  });

  async function sendFeedback(rating) {
    try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ rating }) }); toast('Feedback saved'); }
    catch (e) { toast(e.message); }
  }

  function copy(text) {
    const ok = () => toast('Copied to clipboard');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
    function fallback() { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); ok(); } catch (e) { toast('Copy failed'); } t.remove(); }
  }

  /* ---------- Documents ---------- */
  async function computeSHA256(file) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function loadDocs() {
    const docsEl = $('docs');
    docsEl.innerHTML = '<div class="empty">Loading documents...</div>';
    try {
      const r = await api('/api/documents');
      docsEl.innerHTML = '';
      if (!r.documents.length) { docsEl.innerHTML = '<div class="empty">No documents uploaded yet.</div>'; return; }
      r.documents.forEach(d => {
        const row = document.createElement('div'); row.className = 'doc-row';
        const st = (d.status || 'queued').toLowerCase();
        const statusClass = ['ready', 'processing', 'queued', 'pending', 'failed'].includes(st) ? st : 'queued';

        let actionsHtml = '';
        if (st === 'failed') {
          actionsHtml = `<button class="btn retry-btn" data-retry="${esc(String(d.id))}" title="Retry ingestion"><i class="fa-solid fa-rotate-right"></i> Retry</button>`;
        }

        let errorHtml = '';
        if (st === 'failed' && d.error_message) {
          errorHtml = `<div class="doc-error"><i class="fa-solid fa-circle-exclamation"></i> ${esc(d.error_message)}</div>`;
        }

        row.innerHTML = `
          <div class="doc-main">
            <i class="fa-solid fa-file-lines"></i>
            <div class="doc-info">
              <span class="doc-title">${esc(d.title)}</span>
              ${errorHtml}
            </div>
            <span class="doc-status ${statusClass}">${esc(st)} (v${d.current_version})</span>
            ${actionsHtml}
          </div>
        `;
        docsEl.appendChild(row);
      });
    } catch (e) { docsEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  $('docs').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-retry]');
    if (!btn) return;
    const docId = btn.dataset.retry;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Retrying...';
    toast('Retrying ingestion...');
    try {
      await api(`/api/documents/${encodeURIComponent(docId)}/retry`, { method: 'POST' });
      toast('Document indexed successfully!');
      loadDocs();
    } catch (err) {
      toast('Retry failed: ' + err.message);
      loadDocs();
    }
  });

  let isUploading = false;
  $('uploadForm').onsubmit = async e => {
    e.preventDefault();
    if (isUploading) return;

    const fileInput = $('file');
    const submitBtn = $('uploadForm').querySelector('button[type="submit"]');
    const f = fileInput.files[0];
    if (!f) return;
    if (f.size > 10485760) { toast('Maximum file size is 10 MB'); return; }

    isUploading = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading...';
    }
    fileInput.disabled = true;

    try {
      toast('Calculating file checksum...');
      const checksum = await computeSHA256(f);

      const r = await api('/api/documents/uploads', {
        method: 'POST',
        body: JSON.stringify({ filename: f.name, checksum_sha256: checksum })
      });

      if (r.already_exists) {
        if (r.status === 'ready') {
          toast('Document already exists and is ready!');
        } else {
          toast(r.message || `Document is already ${r.status}.`);
        }
        fileInput.value = '';
        loadDocs();
        return;
      }

      toast('Uploading to S3...');
      const up = await fetch(r.upload_url, { method: 'PUT', headers: r.headers, body: f });
      if (!up.ok) throw Error('S3 upload failed');

      toast('Uploaded to S3. Ingesting and indexing document...');
      await api('/api/documents/complete', {
        method: 'POST',
        body: JSON.stringify({ document_id: r.document_id })
      });

      toast('Document indexed in Pinecone successfully!');
      fileInput.value = '';
      loadDocs();
    } catch (err) {
      toast(err.message);
      loadDocs();
    } finally {
      isUploading = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = 'Upload document';
      }
      fileInput.disabled = false;
    }
  };

  /* ---------- Metrics ---------- */
  async function loadMetrics() {
    try {
      $('metrics').textContent = JSON.stringify(await api('/api/admin/metrics'), null, 2);
      $('guardrailMetrics').textContent = JSON.stringify(await api('/api/admin/guardrails'), null, 2);
    } catch (e) {
      $('metrics').textContent = e.message;
    }
  }

  /* ---------- Approvals ---------- */
  async function loadApprovals() {
    const root = $('approvalList');
    root.innerHTML = '<div class="empty">Loading approvals...</div>';
    try {
      const response = await api('/api/approvals');
      if (!Array.isArray(response.approvals)) throw Error('Unexpected API response: approvals list missing');
      const approvals = response.approvals;
      const pendingCount = approvals.filter(a => String(a.status).trim().toLowerCase() === 'pending').length;
      $('approvalSummary').textContent = `${pendingCount} pending · ${approvals.length} total (most recent 100)`;
      root.innerHTML = '';
      if (!approvals.length) { root.innerHTML = '<div class="empty">No approval requests yet. Try asking the chatbot to delete a document.</div>'; return; }
      for (const a of approvals) {
        const card = document.createElement('article'); card.className = 'approval-card';
        const header = document.createElement('div'); header.className = 'approval-header';
        const title = document.createElement('strong'); title.textContent = a.question;
        const badge = document.createElement('span'); badge.className = 'approval-status ' + a.status; badge.textContent = a.status;
        header.append(title, badge); card.append(header);
        const meta = document.createElement('p'); meta.className = 'approval-meta';
        meta.textContent = `Requested by ${a.requester} · ${new Date(a.created_at).toLocaleString()}`;
        card.append(meta);
        if (String(a.status).trim().toLowerCase() === 'pending') {
          const actions = document.createElement('div'); actions.className = 'approval-actions';
          for (const [label, approve] of [['Approve', true], ['Reject', false]]) {
            const button = document.createElement('button');
            button.textContent = label;
            button.className = approve ? 'approve-button' : 'reject-button';
            button.onclick = async () => {
              const decision = approve ? 'approve' : 'reject';
              if (!confirm(`Are you sure you want to ${decision} this request? This records a decision only and does not execute the requested action.`)) return;
              button.disabled = true;
              try {
                const r = await api(`/api/approvals/${encodeURIComponent(a.id)}/decision`, { method: 'POST', body: JSON.stringify({ approve }) });
                toast(`Request ${r.status}. No action executed.`);
                await loadApprovals();
              } catch (e) { toast(e.message); button.disabled = false; }
            };
            actions.append(button);
          }
          card.append(actions);
        } else {
          const info = document.createElement('p'); info.className = 'approval-meta';
          info.textContent = `Reviewed by ${a.reviewer || 'unknown'} · ${a.reviewed_at ? new Date(a.reviewed_at).toLocaleString() : ''} · No action executed`;
          card.append(info);
        }
        root.append(card);
      }
    } catch (e) {
      root.innerHTML = `<div class="empty">Unable to load approvals: ${esc(e.message)}. Check /api/approvals and your Uvicorn terminal.</div>`;
      console.error('Approvals loading failed:', e);
    }
  }

  /* ---------- Top-level buttons ---------- */
  $('newChat').onclick = newChat;
  $('sendBtn').onclick = send;
  $('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('menuToggle').onclick = () => $('sidebar').classList.toggle('open');
  $('searchBtn').onclick = () => {
    const si = $('searchInput'), open = si.hidden;
    si.hidden = !open; $('newChat').hidden = open;
    if (open) si.focus(); else { si.value = ''; query = ''; renderList(); }
  };
  $('searchInput').oninput = e => { query = e.target.value; renderList(); };
  $('clearAll').onclick = () => {
    if (!state.chats.length) return toast('Nothing to clear');
    modal('Clear all conversations?', '<p>All conversation history will be removed. This cannot be undone.</p>', [
      { label: 'Cancel' },
      { label: 'Clear All', cls: 'danger', fn: () => { state.chats = []; state.activeId = null; save(); renderList(); renderChat(); toast('History cleared'); } }
    ]);
  };
  $('upgradeBtn').onclick = () => modal('Upgrade to Pro', '<p>Unlock unlimited conversations, faster replies and priority access. (Demo only, no payment needed.)</p>', [
    { label: 'Maybe later' },
    { label: 'Upgrade', cls: 'primary', fn: () => toast('Thanks! Pro is not available in this demo') }
  ]);
  $('settingsBtn').onclick = () => {
    modal('Settings', `<label for="setName">Display name</label><input type="text" id="setName" value="${esc(settings.name)}">
      <label class="check"><input type="checkbox" id="setDelay" ${settings.delay ? 'checked' : ''}> Simulate typing delay</label>`, [
      { label: 'Cancel' },
      { label: 'Save', cls: 'primary', fn: () => {
        settings.name = $('setName').value.trim() || 'Atlas User';
        settings.delay = $('setDelay').checked;
        $('userName').textContent = settings.name;
        save(); toast('Settings saved');
      }}
    ]);
  };

  /* ---------- Init ---------- */
  $('userName').textContent = settings.name;
  if (!active() && state.chats.length) state.activeId = state.chats[0].id;
  renderList();
  renderChat();
})();
