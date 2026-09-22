import { LANGUAGES, readSettings, validateSettings, permissionOrigin } from './lib/settings.js';

const form = document.querySelector('form');
const status = document.querySelector('#status');
const save = document.querySelector('#save');
for (const [code, name] of Object.entries(LANGUAGES)) {
  document.querySelector('#target').add(new Option(name, code));
}
function showProvider() {
  const local = form.elements.provider.value === 'openai';
  document.querySelector('#api-fields').hidden = !local;
  document.querySelector('#google-note').hidden = local;
  form.elements.endpoint.disabled = !local;
  form.elements.model.required = local;
}
form.elements.provider.addEventListener('change', showProvider);
save.disabled = true;
try {
  const settings = await readSettings();
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements[key];
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  showProvider();
  save.disabled = false;
} catch {
  status.textContent = '設定を読み込めませんでした。拡張を再読み込みしてください。';
  status.className = 'error';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.className = '';
  save.disabled = true;
  try {
    const settings = validateSettings(Object.fromEntries(['enabled', 'automatic', 'target', 'provider', 'endpoint', 'model', 'apiKey'].map(key => {
      const input = form.elements[key];
      return [key, input.type === 'checkbox' ? input.checked : input.value];
    })));
    // Request on the save gesture, and only for the chosen service origin.
    if (settings.enabled && !await chrome.permissions.request({ origins: [permissionOrigin(settings)] })) throw new Error('アクセスが許可されなかったため、設定は保存していません。');
    await chrome.storage.local.set({ settings });
    status.textContent = '保存しました。開いているDiscordにも反映されます。';
  } catch (error) {
    status.className = 'error';
    status.textContent = error.message;
  } finally {
    save.disabled = false;
  }
});
