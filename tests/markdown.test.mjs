// Pins the markdown pipeline: GFM features render; script, handlers, style, iframes and unsafe schemes are stripped;
// external links open safely and cc.internal links survive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';

test('GFM tables, task lists, strikethrough and autolinks render', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~ and https://example.com/x');
  assert.match(html, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
  assert.match(html, /<input checked disabled type="checkbox" \/> done/);
  assert.match(html, /<input disabled type="checkbox" \/> todo/);
  assert.match(html, /<del>gone<\/del>/);
  assert.match(html, /<a href="https:\/\/example.com\/x"/);
});

test('script, event handlers, style attributes and iframes are stripped', () => {
  const html = renderMarkdown('<script>alert(1)</script><img src="https://x/a.png" onerror="alert(1)"><b style="color:red" onclick="x()">t</b><iframe src="https://evil"></iframe><style>*{}</style><form action="/x"><input type="text"></form>');
  for (const needle of ['script', 'alert', 'onerror', 'onclick', 'style', 'iframe', 'form', 'color:red', 'type="text"']) {
    assert.ok(!html.includes(needle), `${needle} survived: ${html}`);
  }
  assert.match(html, /<img src="https:\/\/x\/a.png" \/>/);
});

test('javascript:, data: and protocol-relative links lose their href; mailto and http survive', () => {
  const html = renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](//evil.example/x) [d](mailto:x@y.z) [e](http://ok.example)');
  assert.ok(!/javascript:|data:text|evil\.example/.test(html), html);
  assert.match(html, /href="mailto:x@y.z"/);
  assert.match(html, /href="http:\/\/ok.example"/);
});

test('an image may be a data: URI but not javascript:', () => {
  assert.match(renderMarkdown('![x](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
  assert.ok(!renderMarkdown('![x](javascript:alert(1))').includes('javascript'));
});

test('an external link opens in a new tab with rel noopener noreferrer, whatever the author wrote', () => {
  const html = renderMarkdown('[x](https://example.com) <a href="https://e.example" target="_self" rel="opener">y</a>');
  assert.equal([...html.matchAll(/rel="noopener noreferrer"/g)].length, 2);
  assert.equal([...html.matchAll(/target="_blank"/g)].length, 2);
  assert.ok(!html.includes('_self') && !html.includes('"opener"'));
});

test('a relative link keeps no target or rel', () => {
  const html = renderMarkdown('<a href="other.md" target="_blank" rel="x">r</a>');
  assert.match(html, /<a href="other.md">r<\/a>/);
});

test('a cc.internal deep link survives', () => {
  const html = renderMarkdown('[open](http://cc.internal/#plugin/code-artifact/a/x-abc123/)');
  assert.match(html, /href="http:\/\/cc.internal\/#plugin\/code-artifact\/a\/x-abc123\/"/);
});
