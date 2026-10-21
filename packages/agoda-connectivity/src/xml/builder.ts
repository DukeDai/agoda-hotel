/**
 * A tiny, dependency-free XML writer.
 *
 * Why not `XMLBuilder` from fast-xml-parser? Because we need EXPLICIT
 * control over escaping: guest names and special requests are user
 * controlled and end up inside the request body, so escaping must be
 * visible, auditable and testable. `fast-xml-parser` is still used for
 * parsing (see ./parse.ts).
 */

export type XmlAttrValue = string | number | boolean | undefined | null;
export type XmlAttrs = Record<string, XmlAttrValue>;

/** An element that may carry attributes, child elements and/or text. */
export interface XmlElement {
  readonly name: string;
  readonly attrs: XmlAttrs;
  readonly children: XmlElement[];
  readonly text?: string;
}

/**
 * Escape the five XML predefined entities.
 *
 * `&` must be replaced first, otherwise the ampersands introduced by the
 * other replacements would be double-escaped.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Element with child elements. */
export function el(name: string, children: XmlElement[] = [], attrs: XmlAttrs = {}): XmlElement {
  return { name, attrs, children };
}

/** Element carrying a text value. `undefined`/`null` renders as an empty element. */
export function leaf(name: string, value: string | number | boolean | undefined | null, attrs: XmlAttrs = {}): XmlElement {
  return {
    name,
    attrs,
    children: [],
    ...(value === undefined || value === null ? {} : { text: String(value) }),
  };
}

/** Element carrying BOTH a text value and attributes. */
export function textEl(
  name: string,
  value: string | number | boolean | undefined | null,
  attrs: XmlAttrs = {},
): XmlElement {
  return {
    name,
    attrs,
    children: [],
    ...(value === undefined || value === null ? {} : { text: String(value) }),
  };
}

/** Render an element tree into an XML document (no declaration). */
export function renderXml(element: XmlElement): string {
  const attrs = renderAttrs(element.attrs);
  if (element.children.length === 0) {
    return element.text === undefined
      ? `<${element.name}${attrs}/>`
      : `<${element.name}${attrs}>${escapeXml(element.text)}</${element.name}>`;
  }
  const inner = element.children.map(renderXml).join('');
  return `<${element.name}${attrs}>${inner}</${element.name}>`;
}

/** Render a full document, declaration included. */
export function renderDocument(element: XmlElement, version = '1.0'): string {
  return `<?xml version="${version}" encoding="UTF-8"?>${renderXml(element)}`;
}

function renderAttrs(attrs: XmlAttrs): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    parts.push(` ${key}="${escapeXml(String(value))}"`);
  }
  return parts.join('');
}
