import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('unpacked extension manifest references existing files and scopes permissions', async () => {
  const root = new URL('../extension/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.ok(manifest.host_permissions.every(origin => /^https:\/\/(discord\.com|ptb\.discord\.com|canary\.discord\.com)\/\*$/.test(origin)));
  const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap(script => [...script.js, ...script.css])];
  await Promise.all(files.map(file => access(new URL(file, root))));
});
