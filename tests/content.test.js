import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 140));

async function setup(t, { html = '<div id="message-content-123">Hello world</div>', automatic = false, respond = async () => ({ text: 'こんにちは世界' }) } = {}) {
  const dom = new JSDOM(`<main>${html}</main>`, { url: 'https://discord.com/channels/1/2', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [];
  const listeners = [];
  const settings = { enabled: true, automatic, target: 'ja' };
  const observed = new Set();
  let intersect;
  dom.window.IntersectionObserver = class {
    constructor(callback) { intersect = callback; }
    observe(element) { observed.add(element); }
    unobserve(element) { observed.delete(element); }
  };
  dom.window.chrome = { runtime: {
    onMessage: { addListener: listener => listeners.push(listener) },
    sendMessage: async message => {
      if (message.type === 'settings') return { ...settings };
      calls.push(message.text);
      return respond(message.text);
    }
  } };
  dom.window.eval(source);
  await tick();
  return { document: dom.window.document, calls, settings,
    visible: () => intersect([...observed].map(target => ({ target, isIntersecting: true }))),
    refresh: async () => { listeners.forEach(listener => listener({ type: 'settings-changed' })); await tick(); }
  };
}

test('manual translation preserves original and displays untrusted output as plain text', async t => {
  const { document, calls } = await setup(t, { respond: async () => ({ text: '<img src=x onerror=alert(1)>' }) });
  assert.equal(calls.length, 0);
  document.querySelector('button').click();
  await tick();
  assert.equal(document.querySelector('[id^=message-content]').textContent, 'Hello world');
  assert.equal(document.querySelector('.dmt-output').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(document.querySelector('.dmt-output img'), null);
  document.querySelector('button').click();
  assert.equal(document.querySelector('.dmt-output').hidden, true);
  assert.equal(calls.length, 1);
});

test('automatic translation only starts after visibility and ignores code/spoilers/editor', async t => {
  const app = await setup(t, { automatic: true, html: '<div id="message-content-1">Hello <code>secret()</code><span class="spoilerContent">spoiler secret</span><img alt="🎉"></div><div contenteditable="true"><div id="message-content-2">draft</div></div>' });
  assert.equal(app.calls.length, 0);
  assert.equal(app.document.querySelectorAll('.dmt').length, 1);
  app.visible();
  await tick();
  assert.deepEqual(app.calls, ['Hello 🎉']);
  app.visible();
  await tick();
  assert.equal(app.calls.length, 1);
});

test('message edits discard stale responses and are translated again', async t => {
  let resolve;
  const app = await setup(t, { respond: text => text === 'Hello world' ? new Promise(r => { resolve = r; }) : Promise.resolve({ text: '新しい訳' }) });
  app.document.querySelector('button').click();
  app.document.querySelector('[id^=message-content]').textContent = 'Edited text';
  await tick();
  resolve({ text: '古い訳' });
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  app.document.querySelector('button').click();
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '新しい訳');
  assert.equal(app.document.querySelectorAll('.dmt').length, 1);
});

test('reply previews with reused message IDs get neither buttons nor automatic requests', async t => {
  const app = await setup(t, { automatic: true, html: `
    <article><div id="message-content-10">Original message</div></article>
    <article>
      <div id="message-reply-context-20" class="repliedMessage_hash">
        <div role="button"><div id="message-content-10" class="repliedTextContent_hash">Quoted preview</div></div>
      </div>
      <div id="message-content-20">Reply body</div>
    </article>` });
  assert.equal(app.document.querySelector('[id^="message-reply-context-"] .dmt'), null);
  assert.equal(app.document.querySelectorAll('.dmt').length, 2);
  app.visible();
  await tick();
  assert.deepEqual(app.calls, ['Original message', 'Reply body']);
  assert.equal(app.document.querySelector('[id^="message-reply-context-"] .dmt'), null);
});

test('a body moved into a reply preview loses its translation and ignores pending output', async t => {
  let resolve;
  const app = await setup(t, { respond: () => new Promise(r => { resolve = r; }) });
  app.document.querySelector('button').click();
  const reply = app.document.createElement('div');
  reply.id = 'message-reply-context-20';
  app.document.querySelector('main').append(reply);
  reply.append(app.document.querySelector('[id^="message-content-"]'));
  resolve({ text: '引用には表示しない' });
  await tick();
  assert.equal(app.document.querySelector('.dmt'), null);
  app.visible();
  await tick();
  assert.equal(app.calls.length, 1);
});

test('disabled settings remove translations and suppress pending output', async t => {
  let resolve;
  const app = await setup(t, { respond: () => new Promise(r => { resolve = r; }) });
  app.document.querySelector('button').click();
  app.settings.enabled = false;
  await app.refresh();
  resolve({ text: '古い訳' });
  await tick();
  assert.equal(app.document.querySelector('.dmt'), null);
});

test('same-language auto results are hidden; failures require explicit retry', async t => {
  let attempt = 0;
  const app = await setup(t, { automatic: true, respond: async () => ++attempt === 1 ? { error: '接続エラー' } : { skipped: 'same-language' } });
  app.visible();
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '接続エラー');
  app.visible();
  await tick();
  assert.equal(attempt, 1);
  app.document.querySelector('button').click();
  await tick();
  assert.equal(attempt, 2);
  assert.equal(app.document.querySelector('button').textContent, '翻訳先と同じ言語です');
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
});
