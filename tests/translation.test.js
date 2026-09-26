import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validateSettings, permissionOrigin } from '../extension/lib/settings.js';
import { skipReason } from '../extension/lib/language.js';
import { translate } from '../extension/lib/providers.js';
import { TranslationEngine } from '../extension/lib/engine.js';

const settings = { ...DEFAULTS, enabled: true };
const unknown = async () => ({ isReliable: false, languages: [] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('Japanese is skipped, but Chinese and mixed English are not guessed from Han', () => {
  assert.equal(skipReason('ありがとうございます！', 'ja'), 'same-language');
  assert.equal(skipReason('日本語です https://example.com', 'ja'), 'same-language');
  assert.equal(skipReason('这是中文消息', 'ja'), null);
  assert.equal(skipReason('Please explain 「ありがとう」 in English', 'ja'), null);
  assert.equal(skipReason('東京', 'ja'), null);
  assert.equal(skipReason('🎉 123 https://example.com', 'ja'), 'no-text');
  assert.equal(skipReason('明日開催予定', 'ja', { isReliable: true, languages: [{ language: 'ja', percentage: 95 }] }), 'same-language');
  assert.equal(skipReason('明日開催予定', 'ja', { isReliable: false, languages: [{ language: 'ja', percentage: 95 }] }), null);
  assert.equal(skipReason('Hello!', 'en-US', { isReliable: true, languages: [{ language: 'en', percentage: 99 }] }), 'same-language');
});

test('validates endpoints and requests only the configured origin', () => {
  assert.equal(permissionOrigin(settings), 'https://translate.googleapis.com/*');
  const local = { ...settings, provider: 'openai', model: 'local-model' };
  assert.equal(permissionOrigin(validateSettings(local)), 'http://localhost:11434/*');
  for (const endpoint of ['http://remote.example/v1', 'file:///etc/passwd', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=secret']) {
    assert.throws(() => validateSettings({ ...local, endpoint }));
  }
  assert.throws(() => validateSettings({ ...local, model: '' }));
  assert.throws(() => validateSettings({ ...settings, target: 'invalid' }));
  assert.throws(() => validateSettings({ ...settings, enabled: 'true' }));
});

test('Google response segments and detected language are preserved', async () => {
  const result = await translate('Hello world', settings, async (url, init) => {
    assert.equal(url.hostname, 'translate.googleapis.com');
    assert.equal(url.searchParams.get('q'), 'Hello world');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify([[['こんにちは', 'Hello'], ['世界', 'world']], null, 'en']));
  });
  assert.deepEqual(result, { text: 'こんにちは世界', detectedLanguage: 'en' });
});

test('local API receives chat messages and only explicitly configured credentials', async () => {
  const local = { ...settings, provider: 'openai', model: 'local-model' };
  await translate('Hello', local, async (url, init) => {
    assert.equal(url, local.endpoint);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(JSON.parse(init.body).model, 'local-model');
    assert.deepEqual(JSON.parse(init.body).messages[1], { role: 'user', content: 'Hello' });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'こんにちは' } }] }));
  });
  await translate('Hello', { ...local, apiKey: 'test-key' }, async (_url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'こんにちは' } }] }));
  });
});

test('provider failures and malformed responses are surfaced', async () => {
  await assert.rejects(translate('Hello', settings, async () => new Response('', { status: 429 })), /制限/);
  await assert.rejects(translate('Hello', settings, async () => new Response('[]')), /有効な訳文/);
  await assert.rejects(translate('Hello', settings, async () => new Response('', { status: 401 })), /APIキー/);
});

test('same-language and non-text messages never reach the provider', async () => {
  let calls = 0;
  const engine = new TranslationEngine({ detect: async () => ({ isReliable: true, languages: [{ language: 'ja', percentage: 100 }] }), translate: async () => { calls++; } });
  assert.equal((await engine.run('日本語です', settings)).skipped, 'same-language');
  assert.equal((await engine.run('明日開催予定', settings)).skipped, 'same-language');
  assert.equal((await engine.run('🎉', settings)).skipped, 'no-text');
  assert.equal(calls, 0);
});

test('provider detection catches same-language messages missed locally', async () => {
  const engine = new TranslationEngine({ detect: unknown, translate: async () => ({ text: '変更済み', detectedLanguage: 'ja' }) });
  assert.equal((await engine.run('東京', settings)).skipped, 'same-language');
});

test('deduplicates in-flight requests and caches completed translations', async () => {
  let calls = 0;
  const gate = deferred();
  const engine = new TranslationEngine({ detect: unknown, translate: async () => { calls++; await gate.promise; return { text: 'こんにちは' }; } });
  const first = engine.run('Hello', settings);
  const second = engine.run('Hello', settings);
  gate.resolve();
  assert.deepEqual(await first, await second);
  await engine.run('Hello', settings);
  assert.equal(calls, 1);
  await engine.run('Hello', { ...settings, target: 'ko' });
  assert.equal(calls, 2);
});

test('bounds concurrency and invalidates queued work after disabling/changing settings', async () => {
  const gate = deferred();
  let calls = 0;
  const engine = new TranslationEngine({ concurrency: 1, detect: unknown, translate: async () => { calls++; await gate.promise; return { text: '訳文' }; } });
  const first = engine.run('First', settings);
  const second = engine.run('Second', settings);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  engine.invalidate();
  gate.resolve();
  await first;
  assert.equal((await second).skipped, 'disabled');
  assert.equal(calls, 1);
  await engine.run('First', settings);
  assert.equal(calls, 2);
});

test('failed requests can be retried and do not block the queue', async () => {
  let calls = 0;
  const engine = new TranslationEngine({ concurrency: 1, detect: unknown, translate: async () => { if (++calls === 1) throw new Error('offline'); return { text: '訳文' }; } });
  await assert.rejects(engine.run('Hello', settings), /offline/);
  assert.deepEqual(await engine.run('Hello', settings), { text: '訳文' });
  assert.equal((await engine.run('Another', { ...settings, enabled: false })).skipped, 'disabled');
  await assert.rejects(engine.run('x'.repeat(12001), settings), /12,000/);
});
