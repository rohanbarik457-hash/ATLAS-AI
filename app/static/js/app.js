/* ATLAS Enterprise AI — UI Controller
   Modern Enterprise Theme (Light / Dark / System), Markdown Engine & Citation Architecture
   State persists in localStorage. API calls go to FastAPI backend endpoints. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'atlas.v1', SKEY = 'atlas.settings';
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  /* ---------- API helper ---------- */
  const api = async (path, options = {}) => {
    const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await res.json();
    if (!res.ok) throw Error(data.detail || 'Request failed');
    return data;
  };

  /* ---------- State & Theme Settings ---------- */
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)); } catch (e) { state = null; }
  if (!state || !Array.isArray(state.chats)) state = { chats: [], activeId: null };

  let settings = { name: 'Atlas User', delay: false, theme: 'light' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SKEY)) || {}); } catch (e) {}

  function applyTheme(theme) {
    const effective = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.setAttribute('data-theme', effective);
  }

  // Live listener for OS dark mode changes when in system mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') applyTheme('system');
  });

  applyTheme(settings.theme || 'light');

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      localStorage.setItem(SKEY, JSON.stringify(settings));
    } catch (e) {}
  };
  const active = () => state.chats.find(c => c.id === state.activeId);
  let query = '', renamingId = null, pending = false;

  /* ---------- Helpers ---------- */
  let toastT;
  const toast = msg => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 2800);
  };
  const plain = html => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.innerText || d.textContent;
  };

  function modal(title, bodyHTML, buttons) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHTML;
    const a = $('modalActions');
    a.innerHTML = '';
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.onclick = () => {
        if (!b.keep && b.fn?.() === false) return;
        if (!b.keep) closeModal();
      };
      a.appendChild(el);
    });
    $('modal').hidden = false;
  }
  const closeModal = () => { $('modal').hidden = true; };
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  /* ---------- Client-side Markdown & Citation Renderer ---------- */
  function renderMarkdown(rawText, msgId) {
    if (!rawText) return '';
    let text = esc(rawText);

    // 1. Code blocks (```lang\ncode\n```)
    const codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const id = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(`<pre class="code-block"><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`);
      return id;
    });

    // 2. Tables: parse lines with | ... |
    const lines = text.split('\n');
    const outLines = [];
    let inTable = false;
    let tableRows = [];

    const isTableRow = l => /^\s*\|.+\|\s*$/.test(l);
    const isTableSep = l => /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(l);

    const flushTable = () => {
      if (!tableRows.length) return;
      let html = '<table>';
      let hasHeader = false;
      if (tableRows.length >= 2 && isTableSep(tableRows[1])) {
        hasHeader = true;
        const headers = tableRows[0].split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
        html += '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead>';
      }
      html += '<tbody>';
      const startIdx = hasHeader ? 2 : 0;
      for (let r = startIdx; r < tableRows.length; r++) {
        if (isTableSep(tableRows[r])) continue;
        const cells = tableRows[r].split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
        html += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      outLines.push(html);
      tableRows = [];
      inTable = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isTableRow(line)) {
        inTable = true;
        tableRows.push(line);
      } else {
        if (inTable) flushTable();
        outLines.push(line);
      }
    }
    if (inTable) flushTable();
    text = outLines.join('\n');

    // 3. Section Headings (###, ##, #)
    text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\s+(.+)$/gm, '<h2>$1</h2>');

    // 4. Blockquotes (> quote)
    text = text.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

    // 5. Ordered lists (1. Item)
    text = text.replace(/(?:^|\n)((?:^\d+\.\s+.+(?:\n|$))+)/gm, (match, listBlock) => {
      const items = listBlock.trim().split('\n').map(l => l.replace(/^\d+\.\s+/, '').trim());
      return '<ol>' + items.map(it => `<li>${it}</li>`).join('') + '</ol>';
    });

    // 6. Unordered lists (- Item or * Item)
    text = text.replace(/(?:^|\n)((?:^[-*]\s+.+(?:\n|$))+)/gm, (match, listBlock) => {
      const items = listBlock.trim().split('\n').map(l => l.replace(/^[-*]\s+/, '').trim());
      return '<ul>' + items.map(it => `<li>${it}</li>`).join('') + '</ul>';
    });

    // 7. Inline styling: Bold (**text**), Italic (*text*), Inline code (`code`)
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
    text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // 8. Interactive Clickable Citations: [1], [2], [1, 2]
    // Replace [1, 2] with multiple buttons
    text = text.replace(/\[(\d+),\s*(\d+)\]/g, (match, c1, c2) => {
      return `<button type="button" class="cite-pill" data-cite="${c1}" data-msg="${msgId}" title="View source reference ${c1}">[${c1}]</button><button type="button" class="cite-pill" data-cite="${c2}" data-msg="${msgId}" title="View source reference ${c2}">[${c2}]</button>`;
    });
    // Replace [1] with single clickable pill
    text = text.replace(/\[(\d+)\]/g, (match, c) => {
      return `<button type="button" class="cite-pill" data-cite="${c}" data-msg="${msgId}" title="View source reference ${c}">[${c}]</button>`;
    });

    // 9. Paragraphs: wrap non-tag lines in <p>
    const chunks = text.split(/\n\s*\n/);
    text = chunks.map(chunk => {
      chunk = chunk.trim();
      if (!chunk) return '';
      if (/^<(h2|h3|h4|ul|ol|table|blockquote|pre)/.test(chunk)) return chunk;
      return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('\n');

    // 10. Restore code blocks
    codeBlocks.forEach((cb, idx) => {
      text = text.replace(`__CODE_BLOCK_${idx}__`, cb);
    });

    return text;
  }

  /* ---------- View switching (workspace tabs) ---------- */
  function view(name) {
    ['chat', 'docs', 'approval', 'admin'].forEach(x => {
      $(x + 'View').classList.toggle('hidden', x !== name);
      $(x + 'Tab').classList.toggle('active', x === name);
    });
    $('heading').textContent = {
      chat: "Ask your organization's knowledge",
      docs: 'Knowledge Library',
      approval: 'Approval requests',
      admin: 'Workspace Operational Overview'
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
    const list = $('chatList');
    list.innerHTML = '';
    const q = query.trim().toLowerCase();
    const items = state.chats.filter(c => c.title.toLowerCase().includes(q));
    if (!items.length) {
      list.innerHTML = `<div class="empty">${state.chats.length ? 'No matching conversations' : 'No conversations yet'}</div>`;
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
      `<div class="item-actions">
        <button data-a="del" title="Delete conversation"><i class="fa-regular fa-trash-can"></i></button>
        <button data-a="ren" title="Rename"><i class="fa-regular fa-pen-to-square"></i></button>
        <span class="indicator"></span>
      </div>`;

    const inp = el.querySelector('.rename-in');
    if (inp) {
      setTimeout(() => { inp.focus(); inp.select(); });
      const done = ok => {
        if (ok && inp.value.trim()) c.title = inp.value.trim();
        renamingId = null;
        save();
        renderList();
      };
      inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      inp.onblur = () => done(true);
      inp.onclick = e => e.stopPropagation();
    }
    el.onclick = e => {
      const b = e.target.closest('button');
      if (b?.dataset.a === 'del') { e.stopPropagation(); return deleteChat(c.id); }
      if (b?.dataset.a === 'ren') { e.stopPropagation(); renamingId = c.id; return renderList(); }
      state.activeId = c.id;
      save();
      renderList();
      renderChat();
      $('sidebar').classList.remove('open');
    };
    return el;
  }

  function deleteChat(id) {
    modal('Delete conversation?', '<p>This conversation and its local memory will be permanently removed.</p>', [
      { label: 'Cancel' },
      { label: 'Delete', cls: 'danger', fn: () => {
        state.chats = state.chats.filter(c => c.id !== id);
        if (state.activeId === id) state.activeId = state.chats[0]?.id || null;
        save();
        renderList();
        renderChat();
        toast('Conversation deleted');
      }}
    ]);
  }

  function newChat() {
    const existing = state.chats.find(c => !c.messages.length);
    if (existing) {
      state.activeId = existing.id;
    } else {
      const c = { id: crypto.randomUUID(), title: 'New conversation', messages: [], conversationId: crypto.randomUUID() };
      state.chats.unshift(c);
      state.activeId = c.id;
    }
    save();
    renderList();
    renderChat();
    view('chat');
    $('msgInput').focus();
    $('sidebar').classList.remove('open');
  }

  /* ---------- Chat Rendering ---------- */
  function renderChat(showTyping) {
    const col = $('chatCol'), c = active();
    if (!c || !c.messages.length) {
      col.innerHTML = `
        <div class="welcome">
          <div class="spark">✦</div>
          <h2>What can I help you find?</h2>
          <p>Ask natural-language questions about your approved organizational documents. Every answer is grounded in retrieved passages with verified citations.</p>
          <div class="suggestions">
            <button data-q="What is the ticket size for RTS?">Ticket size for RTS ↗</button>
            <button data-q="What is the permitted rate of interest under RTS?">Rate of interest under RTS ↗</button>
            <button data-q="What are the different loan types?">Loan types ↗</button>
            <button data-q="What happens if the customer has no income proof?">No income proof rules ↗</button>
          </div>
        </div>
      `;
      col.querySelectorAll('[data-q]').forEach(b => {
        b.onclick = () => {
          $('msgInput').value = b.dataset.q;
          autoResizeInput();
          $('msgInput').focus();
        };
      });
      return;
    }

    let html = '';
    c.messages.forEach((m, i) => {
      if (m.role === 'user') {
        html += `
          <div class="msg-block">
            <div class="msg-user">
              <span class="user-icon"><i class="fa-solid fa-user"></i></span>
              <span class="txt">${esc(m.text)}</span>
              <button class="icon-circle" data-a="edit" data-i="${i}" title="Edit message"><i class="fa-regular fa-pen-to-square"></i></button>
            </div>
          </div>
        `;
      } else {
        const last = i === c.messages.length - 1;
        const renderedAnswer = renderMarkdown(m.text || m.html || '', i);

        // Separate Collapsible Sources & Evidence Section
        let sourcesHtml = '';
        if (m.sources && m.sources.length) {
          sourcesHtml = `
            <details class="sources-drawer" id="sources-drawer-${i}">
              <summary class="sources-toggle">
                <i class="fa-solid fa-folder-open"></i>
                <span>Sources & Evidence (${m.sources.length})</span>
                <i class="fa-solid fa-chevron-down" style="font-size:10px;margin-left:4px"></i>
              </summary>
              <div class="sources-list">
                ${m.sources.map(s => `
                  <div class="source-card" id="source-${i}-${s.index}">
                    <div class="source-card-header">
                      <div class="source-title-wrap">
                        <span class="source-badge">[${esc(String(s.index))}]</span>
                        <strong title="${esc(s.title)}">${esc(s.title)}</strong>
                      </div>
                      <span class="source-page"><i class="fa-regular fa-file"></i> Page ${esc(String(s.page))}</span>
                    </div>
                    <div class="source-excerpt">"${esc(s.excerpt)}"</div>
                  </div>
                `).join('')}
              </div>
            </details>
          `;
        }

        // Status badges
        let statusNotice = '';
        if (m.status === 'pending_approval') {
          statusNotice = `<div class="status-pending"><i class="fa-solid fa-clock"></i> This request requires administrator review. Open the Approvals tab to decide.</div>`;
        } else if (m.status === 'guardrail_blocked') {
          statusNotice = `<div class="status-blocked"><i class="fa-solid fa-shield-halved"></i> Blocked by safety guardrail policies.</div>`;
        }

        html += `
          <div class="msg-block" id="msg-block-${i}">
            <div class="ai-msg-container">
              <div class="ai-header">
                <div class="ai-label">✦ ATLAS AI <i class="fa-regular fa-circle-check" style="font-size:11px"></i></div>
                <span class="ai-tag">Grounded RAG</span>
              </div>
              <div class="ai-body">
                ${renderedAnswer}
                ${statusNotice}
                ${sourcesHtml}
              </div>
              <div class="actions">
                <div class="act-group">
                  <div class="act-pill">
                    <button data-a="like" data-i="${i}" class="${m.liked ? 'on' : ''}" title="Helpful response"><i class="fa-${m.liked ? 'solid' : 'regular'} fa-thumbs-up"></i></button>
                    <span class="sep"></span>
                    <button data-a="dislike" data-i="${i}" class="${m.disliked ? 'on' : ''}" title="Unhelpful"><i class="fa-${m.disliked ? 'solid' : 'regular'} fa-thumbs-down"></i></button>
                    <span class="sep"></span>
                    <button data-a="copy" data-i="${i}" title="Copy answer text"><i class="fa-regular fa-copy"></i></button>
                  </div>
                  <div class="more">
                    <button data-a="more" data-i="${i}" style="width:32px;height:32px" title="More options"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                  </div>
                </div>
                <button class="btn" data-a="feedback" data-i="${i}"><i class="fa-regular fa-thumbs-up"></i> Helpful</button>
              </div>
            </div>
          </div>
        `;
      }
    });

    if (showTyping) {
      html += `
        <div class="msg-block">
          <div class="ai-msg-container">
            <div class="ai-header">
              <div class="ai-label">✦ ATLAS AI</div>
              <span class="ai-tag">Searching & Generating...</span>
            </div>
            <div class="typing"><i></i><i></i><i></i></div>
          </div>
        </div>
      `;
    }

    col.innerHTML = html;
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  }

  /* ---------- Citation click handler ---------- */
  $('chatCol').addEventListener('click', e => {
    const citeBtn = e.target.closest('.cite-pill');
    if (citeBtn) {
      const citeIdx = citeBtn.dataset.cite;
      const msgIdx = citeBtn.dataset.msg;
      const drawer = $(`sources-drawer-${msgIdx}`);
      if (drawer) {
        drawer.open = true;
        const card = $(`source-${msgIdx}-${citeIdx}`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          card.classList.add('highlight');
          setTimeout(() => card.classList.remove('highlight'), 1800);
        }
      }
      return;
    }

    const b = e.target.closest('button[data-a]');
    if (!b) {
      document.querySelectorAll('.menu').forEach(m => m.remove());
      return;
    }
    const c = active();
    if (!c) return;
    const i = +b.dataset.i, m = c.messages[i], a = b.dataset.a;
    document.querySelectorAll('.menu').forEach(x => x.remove());

    if (a === 'like') { m.liked = !m.liked; m.disliked = false; save(); renderChat(); sendFeedback(1); }
    else if (a === 'dislike') { m.disliked = !m.disliked; m.liked = false; save(); renderChat(); sendFeedback(-1); }
    else if (a === 'copy') copy(m.text || plain(m.html || ''));
    else if (a === 'edit') {
      $('msgInput').value = m.text;
      autoResizeInput();
      $('msgInput').focus();
      toast('Edit your message and press send');
    }
    else if (a === 'feedback') { sendFeedback(1); }
    else if (a === 'more') {
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.innerHTML = '<button data-m="copy"><i class="fa-regular fa-copy"></i> Copy text</button><button data-m="del"><i class="fa-regular fa-trash-can"></i> Delete turn</button>';
      b.parentElement.appendChild(menu);
      menu.onclick = ev => {
        ev.stopPropagation();
        const k = ev.target.closest('button')?.dataset.m;
        if (k === 'copy') copy(m.text || plain(m.html || ''));
        if (k === 'del') { c.messages.splice(i - 1, 2); save(); renderChat(); toast('Turn removed'); }
        menu.remove();
      };
    }
  });

  async function sendFeedback(rating) {
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ rating }) });
      toast('Feedback saved. Thank you!');
    } catch (e) {
      toast(e.message);
    }
  }

  function copy(text) {
    const ok = () => toast('Copied to clipboard');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(ok, fallback);
    } else {
      fallback();
    }
    function fallback() {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand('copy'); ok(); } catch (e) { toast('Copy failed'); }
      t.remove();
    }
  }

  /* ---------- Multiline Textarea Auto-Resize & Send ---------- */
  const msgInput = $('msgInput');
  function autoResizeInput() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
  }
  msgInput.addEventListener('input', autoResizeInput);

  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  async function send() {
    const text = msgInput.value.trim();
    if (!text || pending) return;

    if (!active()) {
      const c = { id: crypto.randomUUID(), title: 'New conversation', messages: [], conversationId: crypto.randomUUID() };
      state.chats.unshift(c);
      state.activeId = c.id;
    }
    const c = active();
    if (!c.messages.length) c.title = text.length > 32 ? text.slice(0, 32) + '...' : text;
    c.messages.push({ role: 'user', text });
    msgInput.value = '';
    msgInput.style.height = 'auto';
    save();
    renderList();

    pending = true;
    renderChat(true);

    try {
      const r = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ question: text, conversation_id: c.conversationId || null })
      });

      if (r.conversation_id) c.conversationId = r.conversation_id;

      const aiMsg = {
        role: 'ai',
        text: r.answer,
        sources: r.sources || [],
        status: r.status || 'ok'
      };
      c.messages.push(aiMsg);
      pending = false;
      save();
      renderChat();

      if (r.status === 'pending_approval' && r.approval_id) {
        c.messages[c.messages.length - 1].approvalId = r.approval_id;
        save();
      }
    } catch (err) {
      c.messages.push({ role: 'ai', text: 'Error: ' + err.message, sources: [], status: 'error' });
      pending = false;
      save();
      renderChat();
    }
  }

  /* ---------- Documents & Knowledge Library ---------- */
  async function computeSHA256(file) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function loadDocs() {
    const docsEl = $('docs');
    docsEl.innerHTML = '<div class="empty"><i class="fa-solid fa-spinner fa-spin" style="font-size:20px;color:var(--primary);margin-bottom:8px"></i><br>Loading documents...</div>';
    try {
      const r = await api('/api/documents');
      docsEl.innerHTML = '';
      const badge = $('docCountBadge');
      if (badge) badge.textContent = `${r.documents.length} document${r.documents.length === 1 ? '' : 's'}`;

      if (!r.documents.length) {
        docsEl.innerHTML = '<div class="empty">No documents uploaded yet. Upload a PDF, DOCX, or text file above.</div>';
        return;
      }

      r.documents.forEach(d => {
        const row = document.createElement('div');
        row.className = 'doc-row';
        const st = (d.status || 'queued').toLowerCase();
        const statusClass = ['ready', 'processing', 'queued', 'pending', 'failed'].includes(st) ? st : 'queued';

        const dateStr = d.created_at ? new Date(d.created_at).toLocaleDateString(undefined, {
          month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }) : 'Unknown date';

        let iconClass = 'fa-file-pdf';
        const titleLower = (d.title || '').toLowerCase();
        if (titleLower.endsWith('.docx')) iconClass = 'fa-file-word';
        else if (titleLower.endsWith('.txt') || titleLower.endsWith('.md')) iconClass = 'fa-file-lines';

        let actionsHtml = '';
        if (st === 'failed') {
          actionsHtml = `<button class="retry-btn" data-retry="${esc(String(d.id))}" title="Retry ingestion pipeline"><i class="fa-solid fa-rotate-right"></i> Retry Ingestion</button>`;
        }

        let errorHtml = '';
        if (st === 'failed' && d.error_message) {
          errorHtml = `<div class="doc-error"><i class="fa-solid fa-circle-exclamation"></i> Ingestion error: ${esc(d.error_message)}</div>`;
        }

        const hashShort = d.checksum_sha256 ? `${d.checksum_sha256.slice(0, 10)}...` : 'N/A';

        row.innerHTML = `
          <div class="doc-main">
            <i class="fa-solid ${iconClass}"></i>
            <div class="doc-info">
              <span class="doc-title" title="${esc(d.title)}">${esc(d.title)}</span>
              <div class="doc-meta">
                <span><i class="fa-regular fa-clock"></i> ${dateStr}</span>
                <span><i class="fa-solid fa-code-commit"></i> v${d.current_version}</span>
                <span><i class="fa-solid fa-fingerprint"></i> SHA-256: ${hashShort}</span>
              </div>
              ${errorHtml}
            </div>
            <span class="doc-status ${statusClass}">
              ${st === 'ready' ? '<i class="fa-solid fa-check"></i>' : st === 'processing' ? '<i class="fa-solid fa-spinner fa-spin"></i>' : st === 'failed' ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-regular fa-clock"></i>'}
              ${esc(st)}
            </span>
            ${actionsHtml}
          </div>
        `;
        docsEl.appendChild(row);
      });
    } catch (e) {
      docsEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // File Picker UI feedback
  const fileInput = $('file');
  const filePickerText = $('filePickerText');
  if (fileInput && filePickerText) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) {
        const mb = (f.size / (1024 * 1024)).toFixed(2);
        filePickerText.innerHTML = `<strong>${esc(f.name)}</strong> (${mb} MB)`;
      } else {
        filePickerText.textContent = 'Choose file or drag & drop';
      }
    });
  }

  $('docs').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-retry]');
    if (!btn) return;
    const docId = btn.dataset.retry;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Retrying...';
    toast('Retrying document ingestion...');
    try {
      await api(`/api/documents/${encodeURIComponent(docId)}/retry`, { method: 'POST' });
      toast('Document ingested and indexed successfully!');
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

    const f = $('file').files[0];
    if (!f) return;
    if (f.size > 10485760) {
      toast('Maximum file size is 10 MB');
      return;
    }

    const submitBtn = $('uploadBtn');
    isUploading = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Ingesting...';
    }
    $('file').disabled = true;

    try {
      toast('Computing SHA-256 checksum for idempotency...');
      const checksum = await computeSHA256(f);

      const r = await api('/api/documents/uploads', {
        method: 'POST',
        body: JSON.stringify({ filename: f.name, checksum_sha256: checksum })
      });

      if (r.already_exists) {
        if (r.status === 'ready') {
          toast('Document already exists and is ready in Pinecone!');
        } else {
          toast(r.message || `Document is already ${r.status}.`);
        }
        $('file').value = '';
        if (filePickerText) filePickerText.textContent = 'Choose file or drag & drop';
        loadDocs();
        return;
      }

      toast('Uploading directly to Amazon S3...');
      const up = await fetch(r.upload_url, { method: 'PUT', headers: r.headers, body: f });
      if (!up.ok) throw Error('S3 upload failed');

      toast('Uploaded to S3. Processing embeddings and indexing in Pinecone...');
      await api('/api/documents/complete', {
        method: 'POST',
        body: JSON.stringify({ document_id: r.document_id })
      });

      toast('Document successfully indexed in Pinecone!');
      $('file').value = '';
      if (filePickerText) filePickerText.textContent = 'Choose file or drag & drop';
      loadDocs();
    } catch (err) {
      toast('Upload error: ' + err.message);
      loadDocs();
    } finally {
      isUploading = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload & Ingest';
      }
      $('file').disabled = false;
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
      if (!approvals.length) {
        root.innerHTML = '<div class="empty">No approval requests yet. Try asking the chatbot to delete or export a policy.</div>';
        return;
      }
      for (const a of approvals) {
        const card = document.createElement('article');
        card.className = 'approval-card';
        const header = document.createElement('div');
        header.className = 'approval-header';
        const title = document.createElement('strong');
        title.textContent = a.question;
        const badge = document.createElement('span');
        badge.className = 'approval-status ' + a.status;
        badge.textContent = a.status;
        header.append(title, badge);
        card.append(header);
        const meta = document.createElement('p');
        meta.className = 'approval-meta';
        meta.textContent = `Requested by ${a.requester} · ${new Date(a.created_at).toLocaleString()}`;
        card.append(meta);
        if (String(a.status).trim().toLowerCase() === 'pending') {
          const actions = document.createElement('div');
          actions.className = 'approval-actions';
          for (const [label, approve] of [['Approve', true], ['Reject', false]]) {
            const button = document.createElement('button');
            button.textContent = label;
            button.className = approve ? 'btn approve-button' : 'btn reject-button';
            button.onclick = async () => {
              const decision = approve ? 'approve' : 'reject';
              if (!confirm(`Are you sure you want to ${decision} this request? This records a decision only.`)) return;
              button.disabled = true;
              try {
                const r = await api(`/api/approvals/${encodeURIComponent(a.id)}/decision`, { method: 'POST', body: JSON.stringify({ approve }) });
                toast(`Request ${r.status}. No action executed.`);
                await loadApprovals();
              } catch (e) {
                toast(e.message);
                button.disabled = false;
              }
            };
            actions.append(button);
          }
          card.append(actions);
        } else {
          const info = document.createElement('p');
          info.className = 'approval-meta';
          info.textContent = `Reviewed by ${a.reviewer || 'unknown'} · ${a.reviewed_at ? new Date(a.reviewed_at).toLocaleString() : ''} · No action executed`;
          card.append(info);
        }
        root.append(card);
      }
    } catch (e) {
      root.innerHTML = `<div class="empty">Unable to load approvals: ${esc(e.message)}</div>`;
      console.error('Approvals loading failed:', e);
    }
  }

  /* ---------- Top-level Navigation & Settings Modal ---------- */
  $('newChat').onclick = newChat;
  $('sendBtn').onclick = send;
  $('menuToggle').onclick = () => $('sidebar').classList.toggle('open');
  $('searchBtn').onclick = () => {
    const si = $('searchInput'), open = si.hidden;
    si.hidden = !open;
    $('newChat').hidden = open;
    if (open) si.focus();
    else { si.value = ''; query = ''; renderList(); }
  };
  $('searchInput').oninput = e => { query = e.target.value; renderList(); };

  $('clearAll').onclick = () => {
    if (!state.chats.length) return toast('Nothing to clear');
    modal('Clear all conversations?', '<p>All conversation history will be removed. This cannot be undone.</p>', [
      { label: 'Cancel' },
      { label: 'Clear All', cls: 'danger', fn: () => {
        state.chats = [];
        state.activeId = null;
        save();
        renderList();
        renderChat();
        toast('History cleared');
      }}
    ]);
  };

  $('upgradeBtn').onclick = () => modal(
    'Atlas Enterprise Pro',
    '<p>Unlock dedicated high-throughput Bedrock models, multi-tenant RBAC policies, and live GlassFlow Rius observability.</p>',
    [{ label: 'Got it', cls: 'primary' }]
  );

  /* Settings Modal with Theme Selection (Light / Dark / System) */
  $('settingsBtn').onclick = () => {
    const currentTheme = settings.theme || 'light';
    const bodyHtml = `
      <label class="field-label" for="setName">Display Name</label>
      <input type="text" id="setName" value="${esc(settings.name)}">

      <label class="field-label" style="margin-top:14px">Appearance Theme</label>
      <div class="theme-selector" id="themeSelector">
        <div class="theme-option ${currentTheme === 'light' ? 'selected' : ''}" data-theme="light">
          <i class="fa-regular fa-sun"></i>
          <span>Light</span>
        </div>
        <div class="theme-option ${currentTheme === 'dark' ? 'selected' : ''}" data-theme="dark">
          <i class="fa-regular fa-moon"></i>
          <span>Dark</span>
        </div>
        <div class="theme-option ${currentTheme === 'system' ? 'selected' : ''}" data-theme="system">
          <i class="fa-solid fa-desktop"></i>
          <span>System</span>
        </div>
      </div>

      <label class="check" style="margin-top:12px">
        <input type="checkbox" id="setDelay" ${settings.delay ? 'checked' : ''}>
        Simulate typing delay
      </label>
    `;

    modal('Settings & Preferences', bodyHtml, [
      {
        label: 'Cancel',
        fn: () => {
          // Revert any live preview
          applyTheme(settings.theme || 'light');
        }
      },
      {
        label: 'Save Changes',
        cls: 'primary',
        fn: () => {
          settings.name = $('setName').value.trim() || 'Atlas User';
          settings.delay = $('setDelay').checked;
          const selectedEl = document.querySelector('.theme-option.selected');
          const newTheme = selectedEl ? selectedEl.dataset.theme : 'light';
          settings.theme = newTheme;
          applyTheme(newTheme);
          $('userName').textContent = settings.name;
          save();
          toast('Settings saved');
        }
      }
    ]);

    // Live theme preview on clicking cards in modal
    const themeOpts = document.querySelectorAll('.theme-option');
    themeOpts.forEach(opt => {
      opt.addEventListener('click', () => {
        themeOpts.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        applyTheme(opt.dataset.theme);
      });
    });
  };

  /* ---------- Init ---------- */
  $('userName').textContent = settings.name;
  if (!active() && state.chats.length) state.activeId = state.chats[0].id;
  renderList();
  renderChat();
})();
