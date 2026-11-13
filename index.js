/*
 * Muse Companion Relay — SillyTavern / TauriTavern UI extension (v0.2)
 *
 * Forwards each finished chat message (yours and the character's) as JSON
 * to your own server inbox, so Muse can follow the story in near real
 * time without screenshots.
 *
 * - Works in SillyTavern and TauriTavern (pure frontend extension).
 * - Never reads or sends model API keys. Sends chat text only.
 * - Endpoint + token live in the extension settings (entered in the UI),
 *   never in this file, so this file can be shared/installed via Git.
 */
(function () {
  'use strict';

  const EXT_ID = 'muse-companion-relay';
  const VERSION = '0.2.0';
  const DEFAULTS = {
    enabled: true,
    endpoint: 'http://119.3.178.203:8787/st-inbox',
    token: '',
    sendLastOnChatChange: 3,
    debug: false,
  };

  const seen = new Set();
  let settingsEl = null;

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
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
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
          <small>只发送聊天文字，不发送任何密钥。关掉开关立即停止。</small>
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
    window.MuseCompanion = {
      sendLast: (n = 5) => sendLast(getCtx(), n, 'MANUAL'),
      test: () => post(getCtx(), { kind: 'st-test', event: 'MANUAL_TEST', sentAt: new Date().toISOString() }),
    };
    log(ctx, 'registered');
    return true;
  }

  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (register() || tries > 40) clearInterval(timer);
  }, 500);
})();
