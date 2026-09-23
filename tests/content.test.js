import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const tick = (ms = 240) => new Promise(resolve => setTimeout(resolve, ms));

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
    visible: (isIntersecting = true) => intersect([...observed].map(target => ({ target, isIntersecting }))),
    scroll: () => dom.window.document.querySelector('main').dispatchEvent(new dom.window.Event('scroll')),
    refresh: async () => { listeners.forEach(listener => listener({ type: 'settings-changed' })); await tick(); }
  };
}

test('manual translation preserves original and displays untrusted output as plain text', async t => {
  const app = await setup(t, { respond: async () => ({ text: '<img src=x onerror=alert(1)>' }) });
  const { document, calls } = app;
  assert.equal(calls.length, 0);
  app.visible();
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
  app.visible();
  app.document.querySelector('button').click();
  app.document.querySelector('[id^=message-content]').textContent = 'Edited text';
  await tick();
  resolve({ text: '古い訳' });
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  app.visible();
  app.document.querySelector('button').click();
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '新しい訳');
  assert.equal(app.document.querySelectorAll('.dmt').length, 1);
});

test('removed controls are recreated for an unchanged message and remain usable', async t => {
  const app = await setup(t);
  const body = app.document.getElementById('message-content-123');
  const box = body.nextElementSibling;
  box.remove();
  await tick();
  assert.equal(app.document.getElementById(body.id), body);
  assert.equal(body.textContent, 'Hello world');
  assert.equal(app.document.querySelectorAll('.dmt').length, 1);
  assert.notEqual(body.nextElementSibling, box);
  app.visible();
  body.nextElementSibling.querySelector('button').click();
  await tick();
  assert.deepEqual(app.calls, ['Hello world']);
  assert.equal(app.document.querySelector('.dmt-output').textContent, 'こんにちは世界');
});

test('recreated controls discard pending responses from the removed controls', async t => {
  let resolve;
  const app = await setup(t, { respond: () => new Promise(r => { resolve = r; }) });
  app.document.querySelector('button').click();
  app.document.querySelector('.dmt').remove();
  await tick();
  resolve({ text: '古い訳' });
  await tick();
  assert.equal(app.document.querySelectorAll('.dmt').length, 1);
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  assert.equal(app.document.querySelector('button').disabled, false);
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

test('unrelated DOM updates do not re-read messages, and an edit only reads that body', async t => {
  const app = await setup(t, { html: '<aside></aside><div id="message-content-1">First</div><div id="message-content-2">Second</div>' });
  const reads = [];
  for (const body of app.document.querySelectorAll('[id^="message-content-"]')) {
    const clone = body.cloneNode.bind(body);
    body.cloneNode = deep => { reads.push(body.id); return clone(deep); };
  }
  for (let i = 0; i < 20; i++) app.document.querySelector('aside').textContent = `Typing ${i}`;
  await tick();
  assert.deepEqual(reads, []);
  app.document.getElementById('message-content-2').textContent = 'Edited';
  await tick();
  assert.deepEqual(reads, ['message-content-2']);
});

test('scrolling defers automatic requests and discovery until scrolling stops', async t => {
  const app = await setup(t, { automatic: true });
  app.scroll();
  app.visible();
  const body = app.document.createElement('div');
  body.id = 'message-content-new';
  body.textContent = 'New message';
  app.document.querySelector('main').append(body);
  await tick(120);
  app.scroll();
  await tick(120);
  assert.equal(app.calls.length, 0);
  assert.equal(app.document.querySelectorAll('.dmt').length, 1);
  await tick();
  assert.deepEqual(app.calls, ['Hello world']);
  assert.equal(app.document.querySelectorAll('.dmt').length, 2);
});

test('an arriving translation waits for scroll idle and for its message to be visible', async t => {
  let resolve;
  const app = await setup(t, { automatic: true, respond: () => new Promise(r => { resolve = r; }) });
  app.visible();
  await tick();
  app.scroll();
  resolve({ text: '待機した訳文' });
  await tick(120);
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  app.visible(false);
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  app.visible();
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '待機した訳文');
  assert.equal(app.calls.length, 1);
});

test('a manual click just after scrolling is honored, but its result waits for idle', async t => {
  const app = await setup(t);
  app.visible();
  app.scroll();
  app.document.querySelector('button').click();
  await tick(120);
  assert.deepEqual(app.calls, ['Hello world']);
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, 'こんにちは世界');
});

test('a manual result waits until its message comes back into view', async t => {
  let resolve;
  const app = await setup(t, { respond: () => new Promise(r => { resolve = r; }) });
  app.visible();
  app.document.querySelector('button').click();
  assert.deepEqual(app.calls, ['Hello world']);
  app.scroll();
  app.visible(false);
  resolve({ text: '待機した訳文' });
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '');
  app.visible();
  await tick();
  assert.equal(app.document.querySelector('.dmt-output').textContent, '待機した訳文');
  assert.equal(app.calls.length, 1);
});
