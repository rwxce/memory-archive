/**
 * Tiny element builder. Strings become text nodes and attributes go through `setAttribute`:
 * nothing here ever parses HTML, so untrusted text (titles, authors, messages, file names) stays
 * inert. The viewer never uses innerHTML (ESLint forbids it under viewer/).
 */

export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return el;
}
