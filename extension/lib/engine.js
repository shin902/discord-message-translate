import { baseLanguage, languageText, skipReason } from "./language.js";

export class TranslationEngine {
  #cache = new Map();
  #pending = new Map();
  #active = 0;
  #queue = [];
  #generation = 0;

  constructor({ detect, translate, concurrency = 2, cacheSize = 300 }) {
    Object.assign(this, { detect, translate, concurrency, cacheSize });
  }

  invalidate() {
    this.#generation++;
    this.#cache.clear();
    this.#pending.clear();
  }

  async run(text, settings) {
    if (typeof text !== "string" || !text.trim() || text.length > 12000) throw new Error("翻訳できる本文は1〜12,000文字です。");
    if (!settings.enabled) return { skipped: "disabled" };
    const key = JSON.stringify([text, settings.target, settings.provider, settings.endpoint, settings.model, settings.apiKey]);
    if (this.#cache.has(key)) return this.#cache.get(key);
    if (this.#pending.has(key)) return this.#pending.get(key);
    if (this.#queue.length >= 100) throw new Error("翻訳待ちが多いため、少し待って再試行してください。");
    const generation = this.#generation;
    const task = this.#execute(text, settings, generation).then(result => {
      if (generation === this.#generation) this.#cache.set(key, result);
      if (this.#cache.size > this.cacheSize) this.#cache.delete(this.#cache.keys().next().value);
      return result;
    }).finally(() => { if (this.#pending.get(key) === task) this.#pending.delete(key); });
    this.#pending.set(key, task);
    return task;
  }

  async #execute(text, settings, generation) {
    if (this.#active >= this.concurrency) await new Promise(resolve => this.#queue.push(resolve));
    else this.#active++;
    try {
      if (generation !== this.#generation) return { skipped: "disabled" };
      let reason = skipReason(text, settings.target);
      if (!reason) {
        const detected = await this.detect(languageText(text)).catch(() => null);
        reason = skipReason(text, settings.target, detected);
      }
      if (reason) return { skipped: reason };
      if (generation !== this.#generation) return { skipped: "disabled" };
      const result = await this.translate(text, settings);
      if (baseLanguage(result.detectedLanguage) === baseLanguage(settings.target) || result.text.trim() === text.trim()) return { skipped: "same-language" };
      return { text: result.text };
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }
}
