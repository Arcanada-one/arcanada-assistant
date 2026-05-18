/**
 * Telegram MarkdownV2 escape — per Telegram Bot API spec, every character
 * from the set `_*[]()~`>#+-=|{}.!` MUST be escaped with a leading `\`
 * inside body text. Inside formatting wrappers (`*bold*`, `_italic_`) the
 * same rule applies to non-delimiter chars. We use this helper for all
 * dynamic content (task IDs, titles, numbers).
 */
const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMd(input: string): string {
  return input.replace(SPECIAL, (c) => `\\${c}`);
}

export function bold(text: string): string {
  return `*${escapeMd(text)}*`;
}
