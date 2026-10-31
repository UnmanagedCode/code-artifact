// The app the tests publish: plain node:http, no dependencies. Options come from fixture.json beside it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const read = (f, d) => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const opts = JSON.parse(read('fixture.json', '{}'));
const version = read('VERSION', '?').trim();
const { PORT, BASE_PATH, DATA_DIR } = process.env;
const data = (name) => path.join(DATA_DIR, name);

if (opts.failBeforeListen) { console.error('fixture failing before listen'); process.exit(3); }
if (opts.ignoreTerm) process.on('SIGTERM', () => {});
if (DATA_DIR) fs.writeFileSync(data('pid'), String(process.pid));

const server = http.createServer((req, res) => {
  if (opts.requireBase && !(req.url === BASE_PATH || req.url.startsWith(`${BASE_PATH}/`) || req.url.startsWith(`${BASE_PATH}?`))) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(`outside the base: ${req.url}`);
  }
  const u = new URL(req.url, 'http://fixture');
  const p = u.pathname.startsWith(`${BASE_PATH}/`) ? u.pathname.slice(BASE_PATH.length) : u.pathname;
  const json = (obj, headers = {}) => {
    res.writeHead(200, { 'content-type': 'application/json', ...(opts.csp && { 'content-security-policy': opts.csp }), ...headers });
    res.end(JSON.stringify(obj));
  };
  if (p === '/echo') {
    const installs = read(data('installs'), '').split('\n').filter(Boolean).length;
    return json({ method: req.method, url: req.url, headers: req.headers, env: { PORT, BASE_PATH, DATA_DIR }, version, cwd: process.cwd(), installs });
  }
  if (p === '/redirect') {
    res.writeHead(302, { location: u.searchParams.get('to') });
    return res.end();
  }
  if (p === '/cookies') return json({}, { 'set-cookie': u.searchParams.getAll('c') });
  if (p === '/body') {
    let n = 0;
    req.on('data', (d) => { n += d.length; });
    return req.on('end', () => json({ length: n, type: req.headers['content-type'] }));
  }
  if (p === '/data') {
    if (u.searchParams.has('add')) fs.appendFileSync(data('data.txt'), `${u.searchParams.get('add')}\n`);
    return json({ data: read(data('data.txt'), '') });
  }
  if (p === '/spawn') {
    const child = cp.spawn('sleep', ['300'], { stdio: 'ignore' });
    fs.writeFileSync(data('grandchild.pid'), String(child.pid));
    return json({ pid: child.pid });
  }
  if (p === '/spam') {
    process.stdout.write('x'.repeat(Number(u.searchParams.get('bytes'))) + '\n');
    return json({ ok: true });
  }
  if (p === '/write-cwd') {
    fs.writeFileSync('written-by-app.txt', 'x');
    return json({ ok: true });
  }
  res.writeHead(200, { 'content-type': 'text/html', ...(opts.csp && { 'content-security-policy': opts.csp }) });
  return res.end(`<!doctype html><title>fixture</title><h1 id="hello">fixture v${version}</h1><p>${req.url}</p>`);
});

server.on('upgrade', (req, socket) => {
  socket.write([
    'HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: fixture',
    `X-Seen-Url: ${req.url}`, `X-Seen-Host: ${req.headers.host}`, `X-Seen-Prefix: ${req.headers['x-forwarded-prefix'] || ''}`, '', '',
  ].join('\r\n'));
  socket.on('data', (d) => socket.write(d));
  socket.on('error', () => {});
});

if (opts.neverListen) {
  setInterval(() => {}, 1000);
} else {
  server.listen(Number(PORT), '127.0.0.1', () => {
    console.log(`fixture listening on ${PORT}`);
    if (opts.exitAfterMs) setTimeout(() => process.exit(0), opts.exitAfterMs);
  });
}
