import { readSettings, permissionOrigin } from "./lib/settings.js";
import { TranslationEngine } from "./lib/engine.js";
import { translate } from "./lib/providers.js";

// Credentials stay in trusted extension contexts, never in Discord's content script.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const engine = new TranslationEngine({ detect: text => chrome.i18n.detectLanguage(text), translate });

function isDiscord(sender) {
  try {
    const url = new URL(sender.url);
    return sender.id === chrome.runtime.id && url.protocol === "https:" && ["discord.com", "ptb.discord.com", "canary.discord.com"].includes(url.hostname);
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isDiscord(sender) || !["settings", "translate"].includes(message?.type)) return false;
  (async () => {
    await storageReady;
    const settings = await readSettings();
    if (message.type === "settings") return { enabled: settings.enabled, automatic: settings.automatic, target: settings.target };
    if (!new URL(sender.url).pathname.startsWith("/channels/")) throw new Error("Discordのチャンネルを開いてください。");
    if (!settings.enabled) return { skipped: "disabled" };
    if (!await chrome.permissions.contains({ origins: [permissionOrigin(settings)] })) throw new Error("拡張の設定を開き、翻訳サービスへのアクセスを許可してください。");
    return engine.run(message.text, settings);
  })().then(respond).catch(error => respond({ error: error.name === "TimeoutError" ? "翻訳がタイムアウトしました。再試行してください。" : error instanceof TypeError ? "接続できませんでした。API URLとサーバーの起動状態を確認してください。" : error.message }));
  return true;
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local" || !_changes.settings) return;
  engine.invalidate();
  // Tabs permission is unnecessary: only send to known Discord URLs.
  chrome.tabs.query({ url: ["https://discord.com/*", "https://ptb.discord.com/*", "https://canary.discord.com/*"] }).then(tabs => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: "settings-changed" }).catch(() => {});
  });
});
