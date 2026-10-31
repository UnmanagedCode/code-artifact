import http from 'node:http';
import net from 'node:net';
import { ID_RE } from './links.js';
import { plain, wrap } from './http.js';
import { forwardHeaders, rewriteLocation, rewriteSetCookie, selfOrigins, upstreamPath } from './appRewrite.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** `{id, rest}` for a raw request URL under `/app/<id>`; `rest` is the path plus query after the id, or undefined. */
function parseAppUrl(url) {
  const m = /^\/app\/([^/?]+)([/?].*)?$/s.exec(url);
  return m && ID_RE.test(m[1]) ? { id: m[1], rest: m[2] } : null;
}

const hostHeader = (target) => (target.host === '::1' ? `[::1]:${target.port}` : `127.0.0.1:${target.port}`);

function upstreamRequest(req, target) {
  const rest = parseAppUrl(req.url).rest;
  return {
    path: upstreamPath(target.prefix, target.basePath, rest),
    headers: forwardHeaders(req.rawHeaders, { upstreamHost: hostHeader(target), basePath: target.basePath, remoteAddress: req.socket.remoteAddress }),
  };
}

/** Why there is nothing to proxy to: 404 for an id that is not an app, 503 for an app that is not running. */
async function refusalStatus(apps, id) {
  return (await apps.kindOf(id)) === 'app' ? 503 : 404;
}

/**
 * Express middleware for `/app/<id>/…`: streams the request to the running app and its response back.
 * Mounted before the JSON gate, so an app's own form posts pass.
 */
export function appProxyRouter(apps) {
  return wrap(async (req, res, next) => {
    const parsed = parseAppUrl(req.url);
    if (!parsed) return next();
    const { id, rest } = parsed;
    if (rest === undefined || rest.startsWith('?')) return res.redirect(301, `${id}/${rest ?? ''}`);
    const target = apps.target(id);
    if (!target) return plain(res, await refusalStatus(apps, id));

    const { path, headers } = upstreamRequest(req, target);
    const upstreamOrigins = selfOrigins(target.port, req.headers['x-forwarded-host'] ?? req.headers.host);
    const locate = { basePath: target.basePath, mount: target.mount, id, upstreamOrigins };

    const up = http.request({ host: target.host, port: target.port, method: req.method, path, headers }, (ures) => {
      // The app's own policy applies to the app: ours is for the plugin's pages.
      res.removeHeader('Content-Security-Policy');
      res.removeHeader('X-Content-Type-Options');
      res.statusCode = ures.statusCode;
      res.statusMessage = ures.statusMessage;
      const seen = new Map();
      for (let i = 0; i < ures.rawHeaders.length; i += 2) {
        const name = ures.rawHeaders[i];
        const lower = name.toLowerCase();
        if (HOP_BY_HOP.has(lower)) continue;
        let value = ures.rawHeaders[i + 1];
        if (lower === 'location') value = rewriteLocation(value, locate);
        else if (lower === 'set-cookie') value = rewriteSetCookie(value, locate);
        const entry = seen.get(lower) ?? { name, values: [] };
        entry.values.push(value);
        seen.set(lower, entry);
      }
      for (const { name, values } of seen.values()) res.setHeader(name, values.length === 1 ? values[0] : values);
      ures.pipe(res);
    });
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy(e);
      return plain(res, 502);
    });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
    return undefined;
  });
}

const refuseUpgrade = (socket, status) => {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
};

/** The `upgrade` listener: pipes a WebSocket upgrade for `/app/<id>/…` raw to the running app; anything else is refused and closed. */
export function appUpgrade(apps) {
  return async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const parsed = parseAppUrl(req.url);
    if (!parsed || parsed.rest === undefined || parsed.rest.startsWith('?')) return refuseUpgrade(socket, 404);
    let target;
    try {
      target = apps.target(parsed.id);
      if (!target) return refuseUpgrade(socket, await refusalStatus(apps, parsed.id));
    } catch {
      return refuseUpgrade(socket, 503);
    }
    const { path, headers } = upstreamRequest(req, target);
    let up = null;
    const closeBoth = () => { up?.destroy(); socket.destroy(); };
    socket.once('close', closeBoth); // before connecting: a client that leaves mid-connect must not leak the upstream socket
    up = net.connect(target.port, target.host);
    up.once('connect', () => {
      if (socket.destroyed) return up.destroy();
      let lines = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`;
      up.write(`${lines}\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
      up.once('close', closeBoth);
      return undefined;
    });
    up.once('error', () => {
      if (up.connecting) { // never reached the app: the client gets a 502, then the pair goes
        up.destroy();
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n', () => socket.destroy());
      } else {
        closeBoth();
      }
    });
    return undefined;
  };
}
