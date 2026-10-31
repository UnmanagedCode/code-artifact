// Behaviour of the app wrapper page: live status, Start/Stop, the log tail, and the iframe that shows the running app.
(function () {
  var body = document.body;
  var api = body.getAttribute('data-api');
  if (!api) return;
  var stage = body.querySelector('[data-role="stage"]');
  var badge = body.querySelector('[data-role="status"]');
  var toggle = body.querySelector('[data-role="toggle"]');
  var status = body.getAttribute('data-status');
  var timer = null;
  var actionError = body.querySelector('[data-role="action-error"]');

  var TEXT = {
    stopped: 'This app is stopped.',
    installing: 'Installing dependencies…',
    starting: 'Starting…',
    failed: 'The app failed.'
  };
  // A refused Start/Stop shows in the bar, whatever the state: while running there is no panel to carry it.
  function setFailure(message) {
    actionError.textContent = message || '';
    actionError.hidden = !message;
  }
  var isActive = function (s) { return s === 'installing' || s === 'starting' || s === 'running'; };

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text) node.textContent = text;
    return node;
  }

  function panel() {
    var p = stage.querySelector('.app-panel');
    if (p) return p;
    p = el('section', { 'class': 'app-panel' });
    p.appendChild(el('p', { 'class': 'app-state', 'data-role': 'state-text' }));
    p.appendChild(el('p', { 'class': 'app-error', 'data-role': 'error' }));
    var para = el('p');
    var start = el('button', { type: 'button', 'class': 'btn primary', 'data-role': 'start' }, 'Start');
    start.addEventListener('click', function () { act('start'); });
    para.appendChild(start);
    p.appendChild(para);
    p.appendChild(el('pre', { 'class': 'log', 'data-role': 'log', 'aria-label': 'App log' }));
    stage.appendChild(p);
    return p;
  }

  function render(st) {
    var changed = st.status !== status;
    status = st.status;
    body.setAttribute('data-status', status);
    badge.textContent = status;
    badge.setAttribute('data-tone', status);
    toggle.textContent = isActive(status) ? 'Stop' : 'Start';
    if (status === 'running') {
      if (!stage.querySelector('iframe')) {
        var old = stage.querySelector('.app-panel');
        if (old) old.remove();
        stage.appendChild(el('iframe', { 'class': 'site', title: body.getAttribute('data-title') || '', src: body.getAttribute('data-frame-src') }));
      }
      return;
    }
    var frame = stage.querySelector('iframe');
    if (frame) frame.remove();
    var p = panel();
    p.querySelector('[data-role="state-text"]').textContent = TEXT[status] || '';
    var err = st.error;
    var errEl = p.querySelector('[data-role="error"]');
    errEl.textContent = err || '';
    errEl.hidden = !err;
    p.querySelector('[data-role="start"]').hidden = isActive(status);
    if (changed) p.querySelector('[data-role="log"]').textContent = '';
  }

  function refreshLog() {
    var pre = stage.querySelector('[data-role="log"]');
    if (!pre) return Promise.resolve();
    return fetch(api + '/log?bytes=8192', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (text) {
      var atEnd = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      pre.textContent = text;
      if (atEnd) pre.scrollTop = pre.scrollHeight;
    });
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(poll, status === 'installing' || status === 'starting' ? 1000 : 5000);
  }

  function poll() {
    fetch(api, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        if (st && st.status) {
          if (st.status !== status) setFailure(null);
          render(st);
        }
        return refreshLog();
      })
      .catch(function () { /* the backend is briefly away: try again */ })
      .then(schedule);
  }

  function act(what) {
    setFailure(null);
    toggle.disabled = true;
    fetch(api + '/' + what, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) setFailure(data.error || 'HTTP ' + r.status);
          return data;
        });
      })
      .then(function (st) { render(st && st.status ? st : { status: status }); return refreshLog(); })
      .catch(function (e) { setFailure(String(e)); })
      .then(function () { toggle.disabled = false; schedule(); });
  }

  toggle.addEventListener('click', function () { act(isActive(status) ? 'stop' : 'start'); });
  var initial = stage.querySelector('[data-role="start"]');
  if (initial) initial.addEventListener('click', function () { act('start'); });
  refreshLog().catch(function () {});
  schedule();
})();
