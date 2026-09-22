export const LANGUAGES = { ja: "日本語", en: "English", ko: "한국어", "zh-CN": "简体中文", "zh-TW": "繁體中文", es: "Español", fr: "Français", de: "Deutsch", ru: "Русский", pt: "Português" };
export const DEFAULTS = Object.freeze({ enabled: false, automatic: false, target: "ja", provider: "google", endpoint: "http://localhost:11434/v1/chat/completions", model: "", apiKey: "" });

export function validateSettings(input) {
  const settings = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, input[key] ?? DEFAULTS[key]]));
  if (typeof settings.enabled !== "boolean" || typeof settings.automatic !== "boolean") throw new Error("設定が不正です。");
  if (!Object.hasOwn(LANGUAGES, settings.target)) throw new Error("翻訳先の言語を選択してください。");
  if (!["google", "openai"].includes(settings.provider)) throw new Error("翻訳サービスを選択してください。");
  for (const key of ["endpoint", "model", "apiKey"]) {
    if (typeof settings[key] !== "string" || settings[key].length > 4096) throw new Error("設定値が不正です。");
    settings[key] = settings[key].trim();
  }
  if (settings.provider === "openai") {
    const url = new URL(settings.endpoint);
    if (url.username || url.password || url.search || url.hash) throw new Error("API URLには認証情報・クエリ・フラグメントを含めないでください。");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("HTTPS、またはlocalhost / 127.0.0.1 のHTTPを指定してください。");
    if (!settings.model) throw new Error("モデル名を入力してください。");
  }
  return settings;
}

export function permissionOrigin(settings) {
  return settings.provider === "google" ? "https://translate.googleapis.com/*" : `${new URL(settings.endpoint).origin}/*`;
}

export async function readSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return validateSettings({ ...DEFAULTS, ...settings });
}
