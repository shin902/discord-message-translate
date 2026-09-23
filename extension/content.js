(() => {
  const SELECTOR = '[id^="message-content-"]';
  const states = new Map();
  const boxOwners = new WeakMap();
  const dirty = new Set();
  const ready = new Map();
  let settings = { enabled: false, automatic: false };
  let generation = 0;
  let timer;
  let scrolling = false;
  let scrollTimer;
  let cleanup = false;

  function isMessageBody(element) {
    // Reply previews reuse the original message's content ID.
    return element.matches(SELECTOR) && !element.closest('[id^="message-reply-context-"], [contenteditable="true"]');
  }

  function extractText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('pre, code, [class*="spoiler"], .dmt').forEach(node => node.remove());
    clone.querySelectorAll('img[alt]').forEach(node => node.replaceWith(node.alt));
    clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    return clone.textContent.trim();
  }

  function schedule() {
    if (!settings.enabled || scrolling || timer) return;
    timer = setTimeout(flush, 100);
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
    boxOwners.set(box, element);
    visibility.observe(element);
    return state;
  }

  function isCurrent(element, state, version) {
    return version === generation && states.get(element) === state && element.isConnected && isMessageBody(element);
  }

  async function run(element, state, manual = false) {
    if (!settings.enabled || (scrolling && !manual) || state.busy || state.done || !isCurrent(element, state, generation)) return;
    const version = generation;
    state.busy = true;
    state.button.disabled = true;
    state.button.textContent = '翻訳中…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'translate', text: state.text });
      if (!result || result.error) throw new Error(result?.error || '翻訳に失敗しました。');
      queueResult(() => {
        state.done = true;
        state.box.classList.remove('dmt-error');
        state.output.textContent = '';
        if (result.skipped) {
          if (!manual) state.box.hidden = true;
          state.button.textContent = result.skipped === 'same-language' ? '翻訳先と同じ言語です' : '翻訳対象の本文がありません';
        } else {
          state.button.textContent = '訳文を隠す';
          state.button.disabled = false;
          // Translation service output is always plain text.
          state.output.textContent = result.text;
          state.output.lang = settings.target;
          state.button.onclick = () => {
            state.output.hidden = !state.output.hidden;
            state.button.textContent = state.output.hidden ? '訳文を表示' : '訳文を隠す';
          };
        }
      });
    } catch (error) {
      queueResult(() => {
        state.box.classList.add('dmt-error');
        state.output.textContent = error.message.includes('Extension context invalidated') ? '拡張を更新しました。Discordを再読み込みしてください。' : error.message;
        state.button.textContent = '再試行';
        state.button.disabled = false;
        state.failed = true;
      });
    }

    function queueResult(render) {
      if (!isCurrent(element, state, version)) return;
      ready.set(element, { state, version, manual, render });
      schedule();
    }
  }

  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = states.get(entry.target);
      if (!state) continue;
      state.visible = entry.isIntersecting;
    }
    schedule();
  });

  function removeState(element, state) {
    visibility.unobserve(element);
    ready.delete(element);
    boxOwners.delete(state.box);
    state.box.remove();
    states.delete(element);
  }

  function flush() {
    timer = null;
    if (!settings.enabled || scrolling) return;
    if (cleanup) {
      for (const [element, state] of states) {
        if (!element.isConnected || !isMessageBody(element)) removeState(element, state);
      }
      cleanup = false;
    }
    for (const element of dirty) {
      let state = states.get(element);
      if (!element.isConnected || !isMessageBody(element) || !location.pathname.startsWith('/channels/')) {
        if (state) removeState(element, state);
        continue;
      }
      const text = extractText(element);
      if (state && (state.text !== text || !state.box.isConnected)) {
        removeState(element, state);
        state = null;
      }
      if (text && !state) createState(element, text);
    }
    dirty.clear();
    for (const [element, result] of ready) {
      if (!isCurrent(element, result.state, result.version)) {
        ready.delete(element);
        continue;
      }
      // Do not change heights above/below the viewport as results arrive.
      // The result remains ready until the message comes back into view.
      if (!result.manual && !result.state.visible) continue;
      ready.delete(element);
      result.render();
      result.state.busy = false;
    }
    if (settings.automatic) {
      for (const [element, state] of states) {
        if (state.visible && !state.failed) run(element, state);
      }
    }
  }

  function collect(node) {
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest('.dmt')) return;
    if (node.matches(SELECTOR)) dirty.add(node);
    node.querySelectorAll(SELECTOR).forEach(element => dirty.add(element));
  }

  const observer = new MutationObserver(mutations => {
    if (!settings.enabled) return;
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      if (!target || target.closest('.dmt')) continue;
      const body = target.closest(SELECTOR);
      if (body) dirty.add(body);
      if (mutation.type === 'attributes') {
        collect(target);
        // Handles a content ID changing or an ancestor becoming a reply preview.
        if (states.has(target)) dirty.add(target);
      }
      for (const node of mutation.addedNodes) collect(node);
      for (const node of mutation.removedNodes) {
        // Discord can remove only the controls while retaining the message body.
        // Our own removals have already cleared this ownership entry.
        const owner = boxOwners.get(node);
        if (owner && !node.isConnected) dirty.add(owner);
        if (node.nodeType !== Node.ELEMENT_NODE || node.matches('.dmt')) continue;
        if (node.matches(SELECTOR) || node.querySelector(SELECTOR)) cleanup = true;
      }
    }
    if (dirty.size || cleanup) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['id'] });

  // Capture nested Discord scrollers without preventing their native behavior.
  document.addEventListener('scroll', () => {
    if (!settings.enabled) return;
    scrolling = true;
    clearTimeout(timer);
    timer = null;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrolling = false;
      flush();
    }, 200);
  }, { capture: true, passive: true });

  async function refreshSettings() {
    const version = ++generation;
    clearTimeout(timer);
    timer = null;
    dirty.clear();
    ready.clear();
    try {
      const next = await chrome.runtime.sendMessage({ type: 'settings' });
      if (version !== generation) return;
      settings = next && !next.error ? next : { enabled: false, automatic: false };
      for (const [element, state] of states) removeState(element, state);
      // A full discovery is only needed at startup or after settings change.
      if (settings.enabled) collect(document.body);
      schedule();
    } catch {
      if (version !== generation) return;
      settings = { enabled: false, automatic: false };
      for (const [element, state] of states) removeState(element, state);
    }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'settings-changed') refreshSettings();
  });
  refreshSettings();
})();
