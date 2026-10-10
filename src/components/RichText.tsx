import { Fragment, type ReactNode } from 'react';

/**
 * The agent answers in light markdown — **bold** labels, bullet lists, the odd
 * `code` span — so rendering its text verbatim shows the asterisks. This turns
 * the common subset into React nodes.
 *
 * Nodes, never HTML: the model's output is untrusted text and never reaches
 * dangerouslySetInnerHTML.
 */

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;
const ORDERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s{0,3}(#{1,4})\s+(.*)$/;

export function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim());

  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');

        if (lines.every((line) => LIST_ITEM.test(line))) {
          const ordered = ORDERED.test(lines[0]);
          const items = lines.map((line) => line.replace(LIST_ITEM, ''));
          return ordered ? (
            <ol key={i} className="rich-list">
              {items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ol>
          ) : (
            <ul key={i} className="rich-list">
              {items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        }

        const heading = lines.length === 1 ? HEADING.exec(lines[0]) : null;
        if (heading) {
          return (
            <p key={i} className="rich-heading">
              {inline(heading[2])}
            </p>
          );
        }

        return (
          <p key={i} className="rich-p">
            {lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

/** **bold**, *italic*, _italic_, `code` — first match wins, nesting ignored. */
function inline(text: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|(?<![A-Za-z0-9])[*_][^*_\n]+[*_](?![A-Za-z0-9]))/g;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];

    if (token.startsWith('**')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = at + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
