// xss-sanitize.js — documents and enforces the textContent-only rendering
// pattern (OUT-05). All untrusted message content is assigned via
// `textContent`, never `innerHTML`. The only allowed innerHTML usage is
// clearing a container (`el.innerHTML = ''`) which carries no untrusted data.

/** Assign untrusted text to an element without ever parsing it as HTML. */
export function setText(el, text) {
  el.textContent = text;
}

/** Build a text node safely (no HTML parsing of `value`). */
export function textNode(value) {
  return document.createTextNode(value);
}

/** Clear a container without injecting any untrusted string. */
export function clear(el) {
  el.innerHTML = '';
}
