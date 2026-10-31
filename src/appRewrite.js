/** Pure request/response rewriting for the app proxy. `basePath` is `<mount>/app/<id>`; `sub` is the raw path after `/app/<id>`, query included. */

/** The path (and query) the app is asked for: `strip` forwards `sub`, `keep` forwards it under `basePath`. */
export const upstreamPath = (prefix, basePath, sub) => (prefix === 'keep' ? basePath + sub : sub);

const REPLACED = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-prefix', 'x-forwarded-for']);

/**
 * The request headers to send upstream, as a flat `[name, value, …]` list in the original order and casing.
 * `Host` becomes the upstream address; the `X-Forwarded-*` set is replaced, and `X-Forwarded-Prefix` is `basePath`.
 */
export function forwardHeaders(rawHeaders, { upstreamHost, basePath, remoteAddress }) {
  const incoming = {};
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (REPLACED.has(name)) incoming[name] = rawHeaders[i + 1];
    else out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  const add = (name, value) => { if (value !== undefined) out.push(name, value); };
  add('Host', upstreamHost);
  add('X-Forwarded-Host', incoming['x-forwarded-host'] ?? incoming.host);
  add('X-Forwarded-Proto', incoming['x-forwarded-proto'] ?? 'http');
  add('X-Forwarded-Prefix', basePath);
  add('X-Forwarded-For', incoming['x-forwarded-for'] ?? remoteAddress);
  return out;
}

/**
 * The origins an app may name itself by: its own address and the host the client used, under either scheme
 * (cc forwards `X-Forwarded-Proto: http` even behind an https share, so the scheme cannot be trusted).
 */
export function selfOrigins(port, forwardedHost) {
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  if (!forwardedHost) return own;
  // The host comes from a client header: only what parses becomes an origin, compared by its normalised form
  // (so `share.example:443` and `https://share.example` agree).
  const named = [];
  for (const scheme of ['http', 'https']) {
    try { named.push(new URL(`${scheme}://${forwardedHost}`).origin); } catch { /* junk host: not an origin */ }
  }
  return [...own, ...named];
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A `Location` in the form the plugin emits, which cc then prefixes with the mount: `/app/<id>/…`.
 * Relative values and redirects to other origins pass unchanged. `upstreamOrigins` are the origins the app may name itself by.
 */
export function rewriteLocation(value, { basePath, mount, id, upstreamOrigins }) {
  let p = value;
  if (value.startsWith('//') || ABSOLUTE.test(value)) {
    let u;
    try { u = new URL(value, 'http://placeholder.invalid'); } catch { return value; }
    const own = value.startsWith('//')
      ? upstreamOrigins.some((o) => new URL(o).host === u.host)
      : upstreamOrigins.includes(u.origin);
    if (!own) return value;
    p = u.pathname + u.search + u.hash;
  } else if (!value.startsWith('/')) {
    return value;
  }
  const carriesBase = p === basePath || ['/', '?', '#'].some((c) => p.startsWith(basePath + c));
  return carriesBase ? p.slice(mount.length) : `/app/${id}${p}`;
}

/** A `Set-Cookie` whose `Path` is confined to `basePath`, so an app cannot shadow cc's or a share's cookies. */
export function rewriteSetCookie(value, { basePath }) {
  const parts = value.split(';');
  return parts.map((part, i) => {
    if (i === 0) return part; // the cookie's own name=value, which may itself be called "path"
    const m = /^(\s*)path\s*=\s*(.*?)\s*$/i.exec(part);
    if (!m || !m[2].startsWith('/')) return part;
    const v = m[2];
    if (v === basePath || v.startsWith(`${basePath}/`)) return part;
    return `${m[1]}Path=${basePath}${v}`;
  }).join(';');
}
