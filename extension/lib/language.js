export const baseLanguage = language => String(language ?? "").toLowerCase().split(/[-_]/)[0];

export function languageText(text) {
  return text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|<[@#][^>]+>/g, " ").trim();
}

export function skipReason(text, target, detection) {
  const prose = languageText(text);
  if (!/\p{L}/u.test(prose)) return "no-text";
  const best = detection?.languages?.[0];
  if (detection?.isReliable && best?.percentage >= 80 && baseLanguage(best.language) === baseLanguage(target)) return "same-language";
  // Short kana phrases often produce an unreliable CLD result. Han alone is
  // deliberately insufficient: it also occurs in Chinese.
  if (target === "ja" && /[\u3041-\u3096\u30a1-\u30fa]/u.test(prose) && !/[\p{Script=Latin}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(prose)) return "same-language";
  return null;
}
