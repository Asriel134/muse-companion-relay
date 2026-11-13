/*
 * Muse Companion Relay — SillyTavern / TauriTavern UI extension (v0.3)
 *
 * Two-way companion:
 *  - Forwards each finished chat message (yours and the character's) as
 *    JSON to your own server inbox, so Muse can follow the story in
 *    near real time without screenshots.
 *  - Polls the same server for Muse's short comments and shows them
 *    in a small floating panel inside the tavern: draggable, collapsible
 *    to a bubble, with an unread badge. Panel colours follow the user's
 *    Konata preset palette (dark plum + hot pink + orchid).
 *
 * - Works in SillyTavern and TauriTavern (pure frontend extension).
 * - Never reads or sends model API keys. Sends chat text only.
 * - Endpoint + token live in the extension settings (entered in the UI),
 *   never in this file, so this file can be shared/installed via Git.
 */
(function () {
  'use strict';

  const EXT_ID = 'muse-companion-relay';
  const VERSION = '0.3.0';
  const DEFAULTS = {
    enabled: true,
    endpoint: 'http://119.3.178.203:8787/st-inbox',
    token: '',
    sendLastOnChatChange: 3,
    debug: false,
    panelOpen: false,
    panelX: null,
    panelY: null,
    lastCommentId: 0,
    commentPollSecs: 15,
  };

  const seen = new Set();
  let settingsEl = null;
  let panelEl = null;
  let unread = 0;

  function getCtx() {
    if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
      return window.SillyTavern.getContext();
    }
    return null;
  }

  function settings(ctx) {
    const store = ctx.extensionSettings || (ctx.extensionSettings = {});
    if (!store[EXT_ID]) store[EXT_ID] = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (store[EXT_ID][k] === undefined) store[EXT_ID][k] = DEFAULTS[k];
    }
    return store[EXT_ID];
  }

  function saveSettings(ctx) {
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
  }

  function log(ctx, ...args) {
    if (settings(ctx).debug) console.log('[MuseCompanion]', ...args);
  }

  function getChatId(ctx) {
    try {
      if (typeof ctx.getCurrentChatId === 'function') return String(ctx.getCurrentChatId());
    } catch (e) { /* ignore */ }
    if (ctx.chatId) return String(ctx.chatId);
    if (ctx.chat_metadata && ctx.chat_metadata.chat_id) return String(ctx.chat_metadata.chat_id);
    return 'unknown-chat';
  }

  /* ---------------- uplink: chat messages -> server inbox ---------------- */

  function post(ctx, payload) {
    const cfg = settings(ctx);
    if (!cfg.enabled) return;
    if (!cfg.endpoint || !cfg.token) {
      log(ctx, 'endpoint/token not set yet');
      return;
    }
    fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Muse-Token': cfg.token,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    }).then(r => log(ctx, 'sent', r.status)).catch(err => log(ctx, 'send failed', err));
  }

  function messagePayload(ctx, eventType, index) {
    const chat = ctx.chat || [];
    let msg = chat[index];
    let idx = index;
    // TauriTavern windowed loading: chat may only hold recent messages.
    // The message that just fired the event is the newest one, so fall
    // back to the last loaded message when the index is outside.
    if (!msg && chat.length) {
      idx = chat.length - 1;
      msg = chat[idx];
    }
    if (!msg) return null;
    const chatId = getChatId(ctx);
    const key = [chatId, idx, msg.swipe_id || 0, (msg.mes || '').length, msg.send_date || ''].join('|');
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      kind: 'st-message',
      event: eventType,
      chatId,
      characterName: ctx.name2 || msg.name || null,
      message: {
        index: idx,
        isUser: !!msg.is_user,
        name: msg.name || (msg.is_user ? ctx.name1 : ctx.name2) || null,
        text: msg.mes || '',
        sendDate: msg.send_date || null,
        swipeId: msg.swipe_id || 0,
      },
      sentAt: new Date().toISOString(),
    };
  }

  function sendByIndex(ctx, eventType, index) {
    const payload = messagePayload(ctx, eventType, index);
    if (payload) post(ctx, payload);
  }

  function sendLast(ctx, n, eventType) {
    const chat = ctx.chat || [];
    const start = Math.max(0, chat.length - n);
    for (let i = start; i < chat.length; i++) sendByIndex(ctx, eventType, i);
  }

  /* ---------------- downlink: server comment box -> floating panel ---------------- */

  function commentsUrl(ctx) {
    const cfg = settings(ctx);
    try {
      const u = new URL(cfg.endpoint);
      return u.origin + '/st-comments';
    } catch (e) {
      return null;
    }
  }

  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    } catch (e) {
      return '';
    }
  }

  function renderComment(comment) {
    if (!panelEl) return;
    const list = panelEl.querySelector('#mc-panel-list');
    if (!list) return;
    if (list.querySelector('[data-mc-id="' + comment.id + '"]')) return;
    const item = document.createElement('div');
    item.className = 'mc-comment';
    item.dataset.mcId = comment.id;
    const head = document.createElement('div');
    head.className = 'mc-comment-head';
    head.textContent = '小此' + (comment.at ? ' · ' + fmtTime(comment.at) : '');
    const body = document.createElement('div');
    body.className = 'mc-comment-text';
    body.textContent = comment.text || '';
    item.appendChild(head);
    item.appendChild(body);
    list.appendChild(item);
    while (list.children.length > 60) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  function setBadge() {
    if (!panelEl) return;
    const badge = panelEl.querySelector('#mc-badge');
    if (!badge) return;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread > 0 ? 'flex' : 'none';
  }

  function fetchComments() {
    const ctx = getCtx();
    if (!ctx) return;
    const cfg = settings(ctx);
    if (!cfg.enabled || !cfg.token) return;
    const url = commentsUrl(ctx);
    if (!url) return;
    fetch(url + '?since=' + encodeURIComponent(cfg.lastCommentId || 0), {
      method: 'GET',
      headers: { 'X-Muse-Token': cfg.token },
    }).then(r => (r.ok ? r.json() : null)).then(data => {
      if (!data || !Array.isArray(data.comments)) return;
      const fresh = data.comments
        .filter(c => Number(c.id) > Number(cfg.lastCommentId || 0))
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (fresh.length) {
        ensurePanel();
        for (const c of fresh) renderComment(c);
        cfg.lastCommentId = Number(data.latest || fresh[fresh.length - 1].id);
        saveSettings(ctx);
        if (!cfg.panelOpen) {
          unread += fresh.length;
          setBadge();
        }
      }
    }).catch(err => log(ctx, 'comment fetch failed', err));
  }

  const PANEL_CSS = `
#mc-panel{position:fixed;z-index:9999;width:54px;height:54px;font-family:inherit;
  --mc-bg:rgba(47,41,48,.94);--mc-border:#584964;--mc-pink:#ff69b4;
  --mc-pink-deep:#d946a6;--mc-orchid:#ba68c8;--mc-text:#feeff4;
  --mc-text-soft:#fbcfe8;--mc-time:#ffb3d9;--mc-mint:#46e0c8;}
#mc-bubble{position:absolute;right:0;bottom:0;width:54px;height:54px;border-radius:50%;
  background:linear-gradient(135deg,var(--mc-pink) 0%,var(--mc-pink-deep) 55%,var(--mc-orchid) 100%);
  color:#fff;font-size:22px;font-weight:700;display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 14px rgba(217,70,166,.45);cursor:pointer;user-select:none;
  -webkit-user-select:none;touch-action:none;border:2px solid rgba(255,179,217,.75);}
#mc-badge{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;border-radius:10px;
  background:var(--mc-mint);color:#20312c;font-size:11px;font-weight:700;
  display:none;align-items:center;justify-content:center;padding:0 5px;
  border:2px solid #2f2930;}
#mc-box{position:absolute;right:0;bottom:64px;width:min(78vw,300px);
  background:var(--mc-bg);border:1.5px solid var(--mc-pink-deep);border-radius:14px;
  box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden;display:none;backdrop-filter:blur(3px);}
#mc-panel.mc-open #mc-box{display:block;}
#mc-head{display:flex;align-items:center;justify-content:space-between;
  padding:8px 12px;cursor:move;touch-action:none;
  background:linear-gradient(90deg,var(--mc-pink-deep),var(--mc-orchid));}
#mc-head .mc-title{color:#fff;font-size:13px;font-weight:700;letter-spacing:.5px;}
#mc-close{background:rgba(255,255,255,.22);color:#fff;border:none;border-radius:8px;
  font-size:12px;padding:3px 9px;cursor:pointer;}
#mc-panel-list{max-height:38vh;overflow-y:auto;padding:8px 10px;scrollbar-width:thin;}
#mc-panel-list:empty::after{content:'还没有评语，我正在窥屏中…';color:var(--mc-time);font-size:12px;}
.mc-comment{padding:6px 8px;margin-bottom:7px;border-radius:10px;
  background:rgba(88,73,100,.45);border:1px solid rgba(255,179,217,.28);}
.mc-comment-head{color:var(--mc-time);font-size:11px;margin-bottom:2px;}
.mc-comment-text{color:var(--mc-text);font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word;}
`;

  function applyPanelPos(ctx) {
    if (!panelEl) return;
    const cfg = settings(ctx);
    let x = cfg.panelX;
    let y = cfg.panelY;
    if (typeof x !== 'number' || typeof y !== 'number') {
      x = Math.max(8, window.innerWidth - 70);
      y = Math.max(8, window.innerHeight - 190);
    }
    x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 54));
    y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 54));
    panelEl.style.left = x + 'px';
    panelEl.style.top = y + 'px';
  }

  function setPanelOpen(ctx, open) {
    const cfg = settings(ctx);
    cfg.panelOpen = !!open;
    saveSettings(ctx);
    if (!panelEl) return;
    panelEl.classList.toggle('mc-open', !!open);
    if (open) {
      unread = 0;
      setBadge();
      fetchComments();
      const list = panelEl.querySelector('#mc-panel-list');
      if (list) list.scrollTop = list.scrollHeight;
    }
  }

  function makeDraggable(ctx, handle, onTap) {
    let startX = 0, startY = 0, origX = 0, origY = 0, moved = false, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.id === 'mc-close') return;
      dragging = true;
      moved = false;
      startX = e.clientX; startY = e.clientY;
      const rect = panelEl.getBoundingClientRect();
      origX = rect.left; origY = rect.top;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      if (!moved) return;
      const nx = Math.min(Math.max(0, origX + dx), Math.max(0, window.innerWidth - 54));
      const ny = Math.min(Math.max(0, origY + dy), Math.max(0, window.innerHeight - 54));
      panelEl.style.left = nx + 'px';
      panelEl.style.top = ny + 'px';
    });
    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      const cfg = settings(ctx);
      const rect = panelEl.getBoundingClientRect();
      cfg.panelX = Math.round(rect.left);
      cfg.panelY = Math.round(rect.top);
      saveSettings(ctx);
      if (!moved && onTap) onTap(e);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function ensurePanel() {
    const ctx = getCtx();
    if (!ctx || !document.body) return;
    if (document.getElementById('mc-panel')) {
      panelEl = document.getElementById('mc-panel');
      return;
    }
    if (!document.getElementById('mc-panel-style')) {
      const style = document.createElement('style');
      style.id = 'mc-panel-style';
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
    }
    const wrap = document.createElement('div');
    wrap.id = 'mc-panel';
    const box = document.createElement('div');
    box.id = 'mc-box';
    const head = document.createElement('div');
    head.id = 'mc-head';
    const title = document.createElement('span');
    title.className = 'mc-title';
    title.textContent = '小此的评语';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'mc-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '收起';
    head.appendChild(title);
    head.appendChild(closeBtn);
    const list = document.createElement('div');
    list.id = 'mc-panel-list';
    box.appendChild(head);
    box.appendChild(list);
    const bubble = document.createElement('div');
    bubble.id = 'mc-bubble';
    bubble.textContent = '此';
    const badge = document.createElement('span');
    badge.id = 'mc-badge';
    bubble.appendChild(badge);
    wrap.appendChild(box);
    wrap.appendChild(bubble);
    document.body.appendChild(wrap);
    panelEl = wrap;
    const cfg = settings(ctx);
    wrap.classList.toggle('mc-open', !!cfg.panelOpen);
    applyPanelPos(ctx);
    makeDraggable(ctx, bubble, () => setPanelOpen(getCtx(), !settings(getCtx()).panelOpen));
    makeDraggable(ctx, head, null);
    closeBtn.addEventListener('click', () => setPanelOpen(getCtx(), false));
    setBadge();
  }

  /* ---------------- settings UI ---------------- */

  function buildSettingsUI(ctx) {
    const host = document.querySelector('#extensions_settings');
    if (!host || document.querySelector('#muse-companion-settings')) return;
    const cfg = settings(ctx);
    const wrap = document.createElement('div');
    wrap.id = 'muse-companion-settings';
    wrap.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Muse 陪看中转</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label">
            <input type="checkbox" id="mc-enabled" ${cfg.enabled ? 'checked' : ''}>
            <span>开启陪看中转</span>
          </label>
          <label>服务器收件箱地址
            <input type="text" id="mc-endpoint" class="text_pole" value="${cfg.endpoint || ''}">
          </label>
          <label>口令（和服务器上的一致）
            <input type="text" id="mc-token" class="text_pole" value="${cfg.token || ''}">
          </label>
          <input type="button" id="mc-test" class="menu_button" value="发一条测试消息">
          <small>只发送聊天文字，不发送任何密钥。关掉开关立即停止。开启后屏幕角落会出现小此的评语悬浮窗（可拖动、可收起）。</small>
        </div>
      </div>`;
    host.appendChild(wrap);
    settingsEl = wrap;
    const bind = (id, key, isCheckbox) => {
      const el = wrap.querySelector(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const c = getCtx();
        settings(c)[key] = isCheckbox ? el.checked : el.value.trim();
        saveSettings(c);
      });
    };
    bind('#mc-enabled', 'enabled', true);
    bind('#mc-endpoint', 'endpoint', false);
    bind('#mc-token', 'token', false);
    const testBtn = wrap.querySelector('#mc-test');
    if (testBtn) testBtn.addEventListener('click', () => {
      const c = getCtx();
      post(c, { kind: 'st-test', event: 'MANUAL_TEST', sentAt: new Date().toISOString() });
    });
  }

  /* ---------------- wiring ---------------- */

  function register() {
    const ctx = getCtx();
    if (!ctx || !ctx.eventSource) return false;
    const types = ctx.event_types || ctx.eventTypes || {};
    const on = (name, fn) => {
      if (types[name]) ctx.eventSource.on(types[name], fn);
    };

    on('MESSAGE_SENT', (id) => sendByIndex(getCtx(), 'MESSAGE_SENT', Number(id)));
    on('MESSAGE_RECEIVED', (id) => sendByIndex(getCtx(), 'MESSAGE_RECEIVED', Number(id)));
    on('MESSAGE_EDITED', (id) => sendByIndex(getCtx(), 'MESSAGE_EDITED', Number(id)));
    on('CHAT_CHANGED', () => {
      const c = getCtx();
      post(c, { kind: 'st-session', event: 'CHAT_CHANGED', chatId: getChatId(c), characterName: c.name2 || null, sentAt: new Date().toISOString() });
      sendLast(c, settings(c).sendLastOnChatChange, 'CHAT_CHANGED');
    });

    buildSettingsUI(ctx);
    ensurePanel();

    const cfg = settings(ctx);
    const pollMs = Math.max(8, Number(cfg.commentPollSecs) || 15) * 1000;
    setTimeout(fetchComments, 4000);
    setInterval(fetchComments, pollMs);
    setInterval(ensurePanel, 5000);

    window.MuseCompanion = {
      sendLast: (n = 5) => sendLast(getCtx(), n, 'MANUAL'),
      test: () => post(getCtx(), { kind: 'st-test', event: 'MANUAL_TEST', sentAt: new Date().toISOString() }),
      fetchComments,
      openPanel: () => setPanelOpen(getCtx(), true),
      version: VERSION,
    };
    log(ctx, 'registered v' + VERSION);
    return true;
  }

  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (register() || tries > 40) clearInterval(timer);
  }, 500);
})();
