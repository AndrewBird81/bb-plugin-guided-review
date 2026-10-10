/**
 * GitHub shows a comment's single line breaks, while Markdown joins the lines.
 * Two trailing spaces make each such break a hard one; fenced code is left as
 * written, and blank lines still separate paragraphs.
 */
export function withLineBreaks(text: string): string {
  const lines = text.split("\n");
  let fenced = false;
  return lines.map((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    const next = lines[index + 1];
    return fenced || next === undefined || !line.trim() || !next.trim() ? line : `${line}  `;
  }).join("\n");
}
