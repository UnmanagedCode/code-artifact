import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img', 'hr', 'br', 'del',
    'details', 'summary', 'input', 'sup', 'sub', 'em', 'strong',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    th: ['align'],
    td: ['align'],
    ol: ['start'],
    input: [{ name: 'type', multiple: false, values: ['checkbox'] }, 'checked', 'disabled'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  transformTags: {
    // An absolute http(s) link leaves the page in a new tab; any other link keeps no target/rel of the author's making.
    a(tagName, attribs) {
      const { target, rel, ...rest } = attribs;
      return /^https?:/i.test(rest.href ?? '')
        ? { tagName, attribs: { ...rest, target: '_blank', rel: 'noopener noreferrer' } }
        : { tagName, attribs: rest };
    },
  },
};

/** GFM markdown → a sanitized HTML fragment. */
export function renderMarkdown(text) {
  return sanitizeHtml(marked.parse(text, { gfm: true, async: false }), OPTIONS);
}
