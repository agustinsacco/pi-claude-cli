/**
 * Tool calls a model wrote as text.
 *
 * A model that sees tool names in its prompt but has no tools (the CLI's MCP
 * client never connected pi's schema server) writes its calls the way its
 * training renders them: `<function_calls>` and `<invoke name="…">` lines in
 * plain text. pi would show that as a finished answer. Only whole-line markers
 * at the very start of a line count, and never inside a fenced code block, so
 * an answer that quotes the syntax is left alone.
 */

const MARKUP_LINE = /^(?:<function_calls>\s*$|<invoke name=")/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function textHasToolCallMarkup(text: string): boolean {
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const opener = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        opener !== undefined &&
        opener[0] === fence[0] &&
        opener.length >= fence.length
      )
        fence = undefined;
      continue;
    }
    if (opener !== undefined) {
      fence = opener;
      continue;
    }
    if (MARKUP_LINE.test(line)) return true;
  }
  return false;
}
