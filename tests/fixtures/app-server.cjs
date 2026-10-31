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

let flooding = false;
let floodWritten = 0;
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
    // Numbered lines then END, so a test can tell the newest bytes from the oldest.
    let out = '';
    for (let i = 1; i <= Number(u.searchParams.get('lines')); i++) out += `line-${String(i).padStart(5, '0')}\n`;
    process.stdout.write(`${out}END\n`);
    return json({ ok: true });
  }
  if (p === '/flood') {
    // Writes `chunk` bytes of log every millisecond for `ms` ms, in the background.
    const chunk = 'f'.repeat(Number(u.searchParams.get('chunk')) - 1);
    const until = Date.now() + Number(u.searchParams.get('ms'));
    flooding = true;
    const timer = setInterval(() => {
      if (Date.now() >= until) { clearInterval(timer); flooding = false; return; }
      process.stdout.write(`${chunk}\n`);
      floodWritten += chunk.length + 1;
    }, 1);
    return json({ ok: true });
  }
  if (p === '/flood-state') return json({ flooding, written: floodWritten });
  if (p === '/abort-body') {
    // Promises 1000 bytes, sends a few, then drops the connection.
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 1000 });
    res.write('partial');
    return setTimeout(() => res.socket.destroy(), 20);
  }
  if (p === '/ws-close') {
    // Ends every upgraded connection from the app's side, leaving the process running.
    const n = upgraded.size;
    for (const s of upgraded) s.end();
    return json({ closed: n });
  }
  if (p === '/ws-open') return json({ open: upgraded.size });
  if (p === '/escape') {
    // A descendant that leaves the process group, so only the run marker in its environment can find it.
    const child = cp.spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    child.unref();
    fs.writeFileSync(data('escaped.pid'), String(child.pid));
    return json({ pid: child.pid });
  }
  if (p === '/escape-ignore-term') {
    // An escaped descendant that ignores SIGTERM (an ignored signal survives the exec); it records its pid once the trap is set.
    const child = cp.spawn('/bin/sh', ['-c', `trap '' TERM; echo $$ > "$DATA_DIR/ignorer.pid"; exec sleep 300`], { stdio: 'ignore', detached: true });
    child.unref();
    return json({ ok: true });
  }
  if (p === '/escape-then-exit') {
    // Leaves an escaped descendant, then exits non-zero on its own once the response is out.
    const child = cp.spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    child.unref();
    fs.writeFileSync(data('escaped.pid'), String(child.pid));
    setTimeout(() => process.exit(1), 20);
    return json({ pid: child.pid });
  }
  if (p === '/escape-spawner') {
    // A descendant outside the process group that keeps spawning more escaped, marked descendants.
    const code = "const cp = require('node:child_process'); setInterval(() => cp.spawn('sleep', ['300'], { stdio: 'ignore', detached: true }).unref(), 5);";
    cp.spawn(process.execPath, ['-e', code], { stdio: 'ignore', detached: true }).unref();
    return json({ ok: true });
  }
  if (p === '/write-cwd') {
    fs.writeFileSync('written-by-app.txt', 'x');
    return json({ ok: true });
  }
  res.writeHead(200, { 'content-type': 'text/html', ...(opts.csp && { 'content-security-policy': opts.csp }) });
  return res.end(`<!doctype html><title>fixture</title><h1 id="hello">fixture v${version}</h1><p>${req.url}</p>`);
});

const upgraded = new Set();
server.on('upgrade', (req, socket) => {
  upgraded.add(socket);
  socket.on('close', () => upgraded.delete(socket));
  socket.write([
    'HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: fixture',
    `X-Seen-Url: ${req.url}`, `X-Seen-Host: ${req.headers.host}`, `X-Seen-Prefix: ${req.headers['x-forwarded-prefix'] || ''}`, '', '',
  ].join('\r\n'));
  socket.on('data', (d) => socket.write(d));
  socket.on('end', () => socket.end()); // an http-server socket is half-open: a real ws server closes on the peer's FIN
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
