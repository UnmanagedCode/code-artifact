import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal, refusalBody } from './refusal.js';
import { plain } from './http.js';

export const DEFAULT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'dist');

// style-src 'unsafe-inline' is for Radix Dialog; img-src for markdown images.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
// The only files served from dist: a name that starts with a letter or digit, one of these extensions, at the root or under assets/.
const ASSET_RE = /^\/((?:assets\/)?[A-Za-z0-9][A-Za-z0-9_-]*\.(html|js|css|svg|png|ico|webmanifest))$/;

/** The CSP and nosniff on every response, the 404 and 503 included. */
export function securityHeaders(_req, res, next) {
  res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
  next();
}

/** A state-changing request must send a JSON content type: a cross-site "simple" request cannot. */
export function jsonOnlyMutations(req, res, next) {
  const jsonType = /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || jsonType) return next();
  const r = new Refusal('UNSUPPORTED_MEDIA_TYPE', 'mutating requests must send Content-Type: application/json');
  return res.status(r.status).json(refusalBody(r));
}

/** Serves the built UI from `dist`: an allowlist, a plain-text 503 while unbuilt, and no SPA fallback. */
export function mountUi(app, dist) {
  // Read per request, so a UI built while the backend runs is served without a restart.
  const built = () => fs.existsSync(path.join(dist, 'index.html'));
  const inside = (rel) => {
    try {
      const root = fs.realpathSync(dist);
      return fs.realpathSync(path.join(root, rel)).startsWith(root + path.sep);
    } catch { return false; }
  };
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch { return next(); }
    const m = p === '/' ? [p, 'index.html', 'html'] : ASSET_RE.exec(p);
    if (!m) return next();
    if (!built()) {
      if (m[2] !== 'html') return next();
      console.error(`UI not built: ${path.join(dist, 'index.html')} is missing — run npm install`);
      return plain(res, 503, 'UI not built — run npm install');
    }
    if (!inside(m[1])) return next();
    return res.sendFile(m[1], { root: dist, dotfiles: 'deny' }, (err) => { if (err) next(err.status === 404 ? undefined : err); });
  });
}

/** Terminal 404 and error handlers: Express's own pages would replace the plugin's CSP. */
export function terminalHandlers(app) {
  app.use((_req, res) => plain(res, 404, 'Not found'));
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? err.statusCode ?? 500;
    if (status === 500) console.error(err);
    return plain(res, status);
  });
}
