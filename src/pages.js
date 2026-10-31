export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// `prefix` is the relative path from the page back to the plugin root ("../../" under a/<id>/).
function shell({ prefix, title, header, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script src="/pluginBridge.js"></script>
<link rel="stylesheet" href="/pluginTheme.css">
<link rel="stylesheet" href="${prefix}_page/fallback.css">
<link rel="stylesheet" href="${prefix}_page/page.css">
<script src="${prefix}_page/theme-init.js"></script>
<script src="${prefix}_page/nav.js"></script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main class="page">
<header class="page-head">
<h1>${escapeHtml(title)}</h1>
${header}
</header>
${body}
</main>
</body>
</html>
`;
}

const stamp = (iso) => `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace('T', ' '))} UTC</time>`;
const downloadLink = (prefix, id, n) => `${prefix}dl/${id}/${n}`;

/** The page for a markdown version: header plus the sanitized, pre-rendered body. */
export function markdownPage({ prefix, id, version, latest, rendered }) {
  const header = `<p class="meta"><span class="badge">v${version.n} · ${latest ? 'latest' : 'pinned'}</span>
<a class="btn" href="${downloadLink(prefix, id, version.n)}">Download</a></p>`;
  return shell({ prefix, title: version.title, header, body: `<article class="md">${rendered}</article>` });
}

/** The landing page for a download version; the attachment itself lives at dl/<id>/<n>. */
export function downloadPage({ prefix, id, version, latest }) {
  const header = `<p class="meta"><span class="badge">v${version.n} · ${latest ? 'latest' : 'pinned'}</span></p>`;
  const body = `<section class="landing">
<p class="file">${escapeHtml(version.file)}</p>
<p class="meta">${formatBytes(version.bytes)} · published ${stamp(version.publishedAt)}</p>
<p><a class="btn primary" href="${downloadLink(prefix, id, version.n)}">Download</a></p>
</section>`;
  return shell({ prefix, title: version.title, header, body });
}
