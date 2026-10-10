/**
 * Text whose `backtick` spans show as code, for titles and one-line summaries
 * where full Markdown would break line clamping. Uses the theme's inline-code
 * colors when it defines them, as bb's chat Markdown does.
 */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) => part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? <code key={index} className="rounded-[4px] bg-[var(--kanagawa-md-code-bg,var(--muted))] px-1 py-px font-mono text-[0.85em] text-[var(--kanagawa-md-code,var(--foreground))]">{part.slice(1, -1)}</code>
        : part)}
    </>
  );
}
