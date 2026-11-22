export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// `prefix` is the relative path from the page back to the plugin root ("../../" under a/<id>/). cc mounts the plugin at
// plugins/<id>/, so cc's host files sit two levels above that root: `${prefix}../../` reaches them at any depth.
const head = (prefix, title) => `<!doctype html>
<html lang="en" data-reload-on-search>
<head>
<meta charset="utf-8">
<script src="${prefix}../../pluginBridge.js"></script>
<link rel="stylesheet" href="${prefix}../../pluginTheme.css">
<link rel="stylesheet" href="${prefix}_page/fallback.css">
<link rel="stylesheet" href="${prefix}_page/page.css">
<script src="${prefix}_page/theme-init.js"></script>
<script src="${prefix}_page/nav.js"></script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
`;

// A latest page polls its artifact's record (assets/update-check.js); a pinned page is one immutable version and never does.
// The live region is always rendered, empty and visually hidden by `:empty` (kept in the accessibility tree): a region inserted or unhidden at the moment of change is not announced.
const updateAttrs = (prefix, id, n) => ` data-update-api="${escapeHtml(`${prefix}api/artifacts/${id}`)}" data-shown-version="${escapeHtml(n)}"`;
const UPDATE_NOTICE = '<div class="update-notice" data-role="update" role="status"></div>';
const updateScript = (prefix) => `<script src="${prefix}_page/update-check.js" defer></script>\n`;

function shell({ prefix, project, title, items, body, update = null }) {
  return `${head(prefix, title)}<body${update ? updateAttrs(prefix, update.id, update.n) : ''}>
<div class="page-top">
${bar(prefix, project, title, items)}
${update ? `${UPDATE_NOTICE}\n` : ''}</div>
<main class="page">
${body}
</main>
${update ? updateScript(prefix) : ''}</body>
</html>
`;
}

const stamp = (iso) => `<time datetime="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace('T', ' '))} UTC</time>`;
// The overview list filtered to the artifact's project: the same `project` param `parseRoute` (frontend/src/lib/artifacts.ts) reads.
const backLink = (prefix, project) =>
  `<a class="btn ghost" href="${escapeHtml(`${prefix}?${new URLSearchParams({ project })}`)}"><span aria-hidden="true">←</span> Artifacts</a>`;
const downloadLink = (prefix, id, n) => `${prefix}dl/${id}/${n}`;
const badge = (version, latest) => `<span class="badge">v${version.n} · ${latest ? 'latest' : 'pinned'}</span>`;
/** The compact header bar of every artifact page; `items` is the markup after the title. */
const bar = (prefix, project, title, items) => `<header class="bar">
${backLink(prefix, project)}
<h1>${escapeHtml(title)}</h1>
${items.join('\n')}
</header>`;

// By the stored file's extension: dl/ derives its Content-Type from the same name.
const PREVIEW_IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const isPreviewImage = (name) => PREVIEW_IMAGE.test(name);

/** The page for a markdown version: the header bar plus the sanitized, pre-rendered body. */
export function markdownPage({ prefix, id, project, version, latest, rendered }) {
  const items = [badge(version, latest), `<a class="btn" href="${downloadLink(prefix, id, version.n)}">Download</a>`];
  return shell({ prefix, project, title: version.title, items, body: `<article class="md">${rendered}</article>`, update: latest ? { id, n: version.n } : null });
}

/**
 * The landing page for a download version; the attachment itself lives at dl/<id>/<n>.
 * An image version also previews inline, as an <img> of that same URL, so an SVG never runs script.
 */
export function downloadPage({ prefix, id, project, version, latest }) {
  const preview = isPreviewImage(version.file)
    ? `<p class="preview"><img src="${downloadLink(prefix, id, version.n)}" alt="${escapeHtml(version.title)}"></p>\n`
    : '';
  const body = `<section class="landing">
${preview}<p class="file">${escapeHtml(version.file)}</p>
<p class="meta">${formatBytes(version.bytes)} · published ${stamp(version.publishedAt)}</p>
<p><a class="btn primary" href="${downloadLink(prefix, id, version.n)}">Download</a></p>
</section>`;
  return shell({ prefix, project, title: version.title, items: [badge(version, latest)], body, update: latest ? { id, n: version.n } : null });
}

/** What `_page/relay.js` reads: the viewed version and the session that published it (empty when none was recorded). */
const reportAttrs = (version, id) => ` data-artifact-id="${escapeHtml(id)}" data-artifact-version="${escapeHtml(version.n)}"`
  + ` data-artifact-title="${escapeHtml(version.title)}" data-publisher-session="${escapeHtml(version.sessionId ?? '')}"`;

// Blocking and first in <body>: its listener must exist before the iframe's page can post a report.
const relayScript = (prefix) => `<script src="${prefix}_page/relay.js"></script>`;

/** The wrapper for a static version: a compact header bar over an iframe (`frameSrc`, a relative raw URL) that shows the site. */
export function staticPage({ prefix, id, project, version, latest, frameSrc }) {
  return `${head(prefix, version.title)}<body class="wrap"${reportAttrs(version, id)}${latest ? updateAttrs(prefix, id, version.n) : ''}>
${relayScript(prefix)}
${bar(prefix, project, version.title, [badge(version, latest), `<a class="btn" href="${downloadLink(prefix, id, version.n)}">Download</a>`])}
${latest ? `${UPDATE_NOTICE}\n` : ''}<iframe class="site" title="${escapeHtml(version.title)}" src="${escapeHtml(frameSrc)}"></iframe>
${latest ? updateScript(prefix) : ''}</body>
</html>
`;
}

const STATE_TEXT = {
  stopped: 'This app is stopped.',
  installing: 'Installing dependencies…',
  starting: 'Starting…',
  failed: 'The app failed.',
};

/**
 * The wrapper for an app: a bar with live status and Start/Stop over an iframe (`frameSrc`, the proxied app) while it runs,
 * else a panel with Start and the log tail. `state` is the host's status for the artifact; `latestN` is the version that runs.
 * Every page's header starts with a link back to the overview list for the artifact's project.
 * A version other than the latest never runs: it gets a notice and a link to the latest.
 */
export function appPage({ prefix, id, project, version, latest, latestN, state, frameSrc }) {
  const runs = version.n === latestN;
  const title = escapeHtml(version.title);
  const versionBadge = badge(version, latest);
  const links = `<a class="btn" href="${prefix}?artifact=${id}">Logs</a>
<a class="btn" href="${downloadLink(prefix, id, version.n)}">Download</a>`;
  if (!runs) {
    return `${head(prefix, version.title)}<body class="wrap app">
${bar(prefix, project, version.title, [versionBadge, links])}
<div class="stage">
<section class="app-panel">
<p class="app-state">v${version.n} does not run; only the latest (v${latestN}) runs.</p>
<p><a class="btn primary" href="${prefix}a/${id}/">Open latest</a></p>
</section>
</div>
</body>
</html>
`;
  }
  const running = state.status === 'running';
  const active = ['installing', 'starting', 'running'].includes(state.status);
  const stage = running
    ? `<iframe class="site" title="${title}" src="${escapeHtml(frameSrc)}"></iframe>`
    : `<section class="app-panel">
<p class="app-state" data-role="state-text">${STATE_TEXT[state.status] ?? ''}</p>
<p class="app-error" data-role="error"${state.error ? '' : ' hidden'}>${escapeHtml(state.error ?? '')}</p>
<p><button type="button" class="btn primary" data-role="start"${active ? ' hidden' : ''}>Start</button></p>
<pre class="log" data-role="log" aria-label="App log"></pre>
</section>`;
  return `${head(prefix, version.title)}<body class="wrap app" data-api="${prefix}api/apps/${id}" data-frame-src="${escapeHtml(frameSrc)}" data-title="${title}" data-status="${state.status}"${reportAttrs(version, id)}${latest ? updateAttrs(prefix, id, version.n) : ''}>
${relayScript(prefix)}
${bar(prefix, project, version.title, [versionBadge, `<span class="badge status" data-role="status" data-tone="${state.status}">${state.status}</span>`, `<button type="button" class="btn" data-role="toggle">${active ? 'Stop' : 'Start'}</button>`, links])}
${latest ? `${UPDATE_NOTICE}\n` : ''}<p class="bar-error" data-role="action-error" role="alert" hidden></p>
<div class="stage" data-role="stage">
${stage}
</div>
<script src="${prefix}_page/app-page.js" defer></script>
${latest ? updateScript(prefix) : ''}</body>
</html>
`;
}
