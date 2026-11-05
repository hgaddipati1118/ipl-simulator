/**
 * Strip personal details from a prompt before it's stored. Prompts are about cricket, so anything
 * shaped like contact details or a link is almost certainly not needed by the sweep.
 */
export function scrubPrompt(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, "[link]")
    // 9+ digits with optional separators, e.g. phone numbers; leaves scores like 180/4 alone
    .replace(/(?<![\w/])\+?\d(?:[\s().-]?\d){8,}(?![\w/])/g, "[number]")
    .trim()
    .slice(0, 2000);
}
