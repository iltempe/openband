// Minimal XML for DAWproject: reading through a DOMParser (the browser's, or @xmldom/xmldom in the Node
// tests), writing with a small builder that escapes everything.

let Parser: { new (): DOMParser } | null = typeof DOMParser !== 'undefined' ? DOMParser : null;
/** Tests: a DOMParser implementation for Node. */
export const setDomParser = (p: { new (): DOMParser }) => void (Parser = p);

export function parseXml(text: string): Element {
  if (!Parser) throw new Error('No XML parser available');
  const doc = new Parser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err || !doc.documentElement) throw new Error(`Not valid XML: ${err?.textContent?.slice(0, 120) ?? 'empty'}`);
  return doc.documentElement;
}

/** Direct children with a tag name (or all element children). */
export function kids(el: Element | null | undefined, tag?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!tag || (n as Element).tagName === tag)) out.push(n as Element);
  return out;
}
export const kid = (el: Element | null | undefined, tag: string): Element | null => kids(el, tag)[0] ?? null;
export const attr = (el: Element | null | undefined, name: string): string | null => (el && el.hasAttribute(name) ? el.getAttribute(name) : null);
export const num = (el: Element | null | undefined, name: string, d = NaN): number => {
  const v = attr(el, name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
export const bool = (el: Element | null | undefined, name: string): boolean | null => {
  const v = attr(el, name);
  return v === null ? null : v === 'true' || v === '1';
};

// ---------------------------------------------------------------- writing

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface XNode {
  tag: string;
  attrs?: Record<string, string | number | boolean | undefined | null>;
  children?: (XNode | null | undefined | false)[];
  text?: string;
}
export const x = (tag: string, attrs?: XNode['attrs'], children?: XNode['children']): XNode => ({ tag, attrs, children });

/** Numbers as plain decimals (no exponent), trimmed. */
export const fmt = (n: number) => {
  if (!Number.isFinite(n)) return '0';
  const s = (Math.round(n * 1e6) / 1e6).toFixed(6);
  return s.replace(/\.?0+$/, '') || '0';
};

export function writeXml(root: XNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'];
  const walk = (n: XNode, depth: number) => {
    const pad = '  '.repeat(depth);
    const a = Object.entries(n.attrs ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? fmt(v) : String(v))}"`)
      .join('');
    const children = (n.children ?? []).filter(Boolean) as XNode[];
    if (n.text !== undefined) return void out.push(`${pad}<${n.tag}${a}>${esc(n.text)}</${n.tag}>\n`);
    if (!children.length) return void out.push(`${pad}<${n.tag}${a}/>\n`);
    out.push(`${pad}<${n.tag}${a}>\n`);
    for (const c of children) walk(c, depth + 1);
    out.push(`${pad}</${n.tag}>\n`);
  };
  walk(root, 0);
  return out.join('');
}
