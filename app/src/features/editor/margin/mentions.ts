/**
 * A comment that mentions `@copilot` is a prompt. A mention inside code (a span or a block), a quoted
 * line (`> ...`) or an address-like token (`@copilot.com`, `me@copilot`) is not one: this starts a paid
 * model job, so it must be what the person meant.
 */
export function mentionsCopilot(text: string): boolean {
  const plain = text
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return /(^|[^\w@.])@copilot(?![\w-]|\.\w)/i.test(plain);
}
