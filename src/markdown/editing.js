// Two spaces nest a list item under a "- " bullet in CommonMark.
export const INDENT = "  ";
// Indents or outdents every line touched by a textarea selection. Textarea
// values only contain "\n" line breaks. Offsets are UTF-16 string offsets.
export function indentLines(text, selectionStart, selectionEnd, outdent) {
  const from =
    selectionStart === 0 ? 0 : text.lastIndexOf("\n", selectionStart - 1) + 1;
  // A selection ending at the start of a line does not touch that line.
  const last =
    selectionEnd > selectionStart && text[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd;
  const stop = text.indexOf("\n", last),
    to = stop < 0 ? text.length : stop;
  const lines = text.slice(from, to).split("\n");
  const deltas = lines.map((line) => {
    if (outdent) return -(/^(?: {1,2}|\t)/.exec(line)?.[0].length || 0);
    return lines.length > 1 && /^[ \t]*$/.test(line) ? 0 : INDENT.length;
  });
  const insert = lines
    .map((line, i) =>
      deltas[i] > 0 ? INDENT + line : line.slice(-deltas[i]),
    )
    .join("\n");
  const map = (p, keepLineStart) => {
    let shift = 0,
      start = from;
    for (let i = 0; i < lines.length; i++) {
      if (p <= start + lines[i].length) {
        const column = p - start;
        if (keepLineStart && column === 0) return p + shift;
        return p + shift + Math.max(deltas[i], -column);
      }
      shift += deltas[i];
      start += lines[i].length + 1;
    }
    return p + shift;
  };
  const changed = deltas.some((d) => d !== 0);
  return {
    changed,
    from,
    to,
    insert,
    text: changed ? text.slice(0, from) + insert + text.slice(to) : text,
    selectionStart: changed
      ? map(selectionStart, selectionEnd > selectionStart)
      : selectionStart,
    selectionEnd: changed ? map(selectionEnd, false) : selectionEnd,
  };
}
