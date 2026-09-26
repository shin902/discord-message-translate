import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../extension/lib/settings.js';

test('background protects credentials, checks senders and enforces optional permission', async () => {
  let handler;
  let access;
  let permission = false;
  let origin;
  globalThis.chrome = {
    runtime: { id: 'extension-id', onMessage: { addListener: listener => { handler = listener; } } },
    storage: {
      local: { setAccessLevel: async value => { access = value.accessLevel; }, get: async () => ({ settings: { ...DEFAULTS, enabled: true, apiKey: 'private-key' } }) },
      onChanged: { addListener() {} }
    },
    permissions: { contains: async value => { origin = value.origins[0]; return permission; } },
    i18n: { detectLanguage: async () => ({ isReliable: false, languages: [] }) }
  };
  try {
    await import('../extension/background.js');
    const sender = { id: 'extension-id', url: 'https://discord.com/channels/1/2' };
    const request = (message, from = sender) => new Promise(resolve => { if (!handler(message, from, resolve)) resolve(null); });
    assert.equal(access, 'TRUSTED_CONTEXTS');
    assert.equal(await request({ type: 'settings' }, { ...sender, url: 'https://evil.example' }), null);
    assert.equal(await request({ type: 'settings' }, { ...sender, id: 'other-extension' }), null);
    assert.deepEqual(await request({ type: 'settings' }), { enabled: true, automatic: false, target: 'ja' });
    assert.match((await request({ type: 'translate', text: 'Hello' })).error, /アクセス/);
    assert.equal(origin, 'https://translate.googleapis.com/*');
    permission = true;
    assert.deepEqual(await request({ type: 'translate', text: 'こんにちは' }), { skipped: 'same-language' });
    assert.match((await request({ type: 'translate', text: 'Hello' }, { ...sender, url: 'https://discord.com/login' })).error, /チャンネル/);
  } finally { delete globalThis.chrome; }
});
