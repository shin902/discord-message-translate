(() => {
  const SELECTOR = '[id^="message-content-"]';
  const states = new Map();
  let settings = { enabled: false, automatic: false };
  let generation = 0;
  let timer;

  function isMessageBody(element) {
    // Discord reuses message-content IDs inside reply previews, including the
    // same ID as the original message. The reply context is a separate surface.
    return element.matches(SELECTOR) && !element.closest('[id^="message-reply-context-"], [contenteditable="true"]');
  }

  function extractText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('pre, code, [class*="spoiler"], .dmt').forEach(node => node.remove());
    clone.querySelectorAll('img[alt]').forEach(node => node.replaceWith(node.alt));
    clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    return clone.textContent.trim();
  }

  function createState(element, text) {
    const box = document.createElement('div');
    box.className = 'dmt';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dmt-button';
    button.textContent = '翻訳';
    button.setAttribute('aria-label', 'このメッセージを翻訳');
    const output = document.createElement('div');
    output.className = 'dmt-output';
    output.setAttribute('aria-live', 'polite');
    box.append(button, output);
    element.after(box);
    const state = { text, box, button, output, busy: false, done: false, visible: false };
    button.addEventListener('click', () => run(element, state, true));
    states.set(element, state);
    visibility.observe(element);
    return state;
  }

  async function run(element, state, manual = false) {
    if (!settings.enabled || state.busy || state.done || !element.isConnected || !isMessageBody(element)) return;
    const version = generation;
    state.busy = true;
    state.button.disabled = true;
    state.button.textContent = '翻訳中…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'translate', text: state.text });
      if (version !== generation || states.get(element) !== state || !element.isConnected || !isMessageBody(element) || extractText(element) !== state.text) return;
      if (!result || result.error) throw new Error(result?.error || '翻訳に失敗しました。');
      state.done = true;
      state.box.classList.remove('dmt-error');
      state.output.textContent = '';
      if (result.skipped) {
        if (!manual) state.box.hidden = true;
        state.button.textContent = result.skipped === 'same-language' ? '翻訳先と同じ言語です' : '翻訳対象の本文がありません';
      } else {
        state.button.textContent = '訳文を隠す';
        state.button.disabled = false;
        // Never interpret a translation service's output as HTML.
        state.output.textContent = result.text;
        state.output.lang = settings.target;
        state.button.onclick = () => {
          state.output.hidden = !state.output.hidden;
          state.button.textContent = state.output.hidden ? '訳文を表示' : '訳文を隠す';
        };
      }
    } catch (error) {
      if (version !== generation || states.get(element) !== state) return;
      state.box.classList.add('dmt-error');
      state.output.textContent = error.message.includes('Extension context invalidated') ? '拡張を更新しました。Discordを再読み込みしてください。' : error.message;
      state.button.textContent = '再試行';
      state.button.disabled = false;
      // Automatic failures are retried only by a deliberate click.
      state.failed = true;
    } finally {
      state.busy = false;
    }
  }

  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = states.get(entry.target);
      if (!state) continue;
      state.visible = entry.isIntersecting;
      if (state.visible && settings.automatic && !state.failed) run(entry.target, state);
    }
  });

  function removeState(element, state) {
    visibility.unobserve(element);
    state.box.remove();
    states.delete(element);
  }

  function scan() {
    if (!settings.enabled) return;
    for (const [element, state] of states) {
      if (!element.isConnected || !isMessageBody(element)) removeState(element, state);
    }
    if (!location.pathname.startsWith('/channels/')) return;
    document.querySelectorAll(SELECTOR).forEach(element => {
      // Only message bodies; never read Discord's editor or reply previews.
      if (!isMessageBody(element)) return;
      const text = extractText(element);
      let state = states.get(element);
      if (state && (state.text !== text || !state.box.isConnected)) {
        removeState(element, state);
        state = null;
      }
      if (text && !state) createState(element, text);
    });
  }

  const observer = new MutationObserver(mutations => {
    const relevant = mutations.some(mutation => {
      if (mutation.target.nodeType === Node.ELEMENT_NODE && mutation.target.closest('.dmt')) return false;
      if (mutation.target.parentElement?.closest('.dmt')) return false;
      if (mutation.type === 'childList' && [...mutation.addedNodes, ...mutation.removedNodes].every(node => node.nodeType === Node.ELEMENT_NODE && node.matches('.dmt'))) return false;
      return true;
    });
    if (!relevant || timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 100);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id'] });

  async function refreshSettings() {
    const version = ++generation;
    try {
      const next = await chrome.runtime.sendMessage({ type: 'settings' });
      if (version !== generation) return;
      settings = next && !next.error ? next : { enabled: false, automatic: false };
      for (const [element, state] of states) removeState(element, state);
      scan();
    } catch {
      settings = { enabled: false, automatic: false };
      for (const [element, state] of states) removeState(element, state);
    }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'settings-changed') refreshSettings();
  });
  refreshSettings();
})();
