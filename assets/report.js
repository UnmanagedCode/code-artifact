// ccArtifact.report(data) for an artifact's own page: posts the data's JSON to the wrapper (the parent document), which relays it to
// the session that published the viewed version. Always resolves, with {ok: true} or {ok: false, code}; protocol in docs/protocol.md.
(function () {
  if (window.ccArtifact) return;
  // Longer than the relay's own deadline, so a relay that answers TIMEOUT is heard; this one covers a parent that never answers.
  var DEADLINE_MS = 30000;
  var pending = {};
  var seq = 0;
  var tag = 'r' + Math.random().toString(36).slice(2) + '-';

  function settle(id, result) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    clearTimeout(p.timer);
    p.resolve(result);
  }

  function report(data) {
    return new Promise(function (resolve) {
      if (window.parent === window) return resolve({ ok: false, code: 'NO_BRIDGE' });
      var json;
      try { json = JSON.stringify(data); } catch (e) { json = undefined; }
      if (typeof json !== 'string') return resolve({ ok: false, code: 'INVALID_DATA' });
      var id = tag + (++seq);
      pending[id] = { resolve: resolve, timer: setTimeout(function () { settle(id, { ok: false, code: 'TIMEOUT' }); }, DEADLINE_MS) };
      try {
        window.parent.postMessage({ ccArtifact: 1, type: 'report', id: id, json: json }, location.origin);
      } catch (e) {
        settle(id, { ok: false, code: 'NO_BRIDGE' }); // an opaque origin cannot name itself as the target
      }
    });
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (ev.source !== window.parent || ev.origin !== location.origin) return;
    if (!d || d.ccArtifact !== 1 || d.type !== 'result' || typeof d.id !== 'string' || !Object.prototype.hasOwnProperty.call(pending, d.id)) return;
    settle(d.id, d.ok === true ? { ok: true } : { ok: false, code: typeof d.code === 'string' ? d.code : 'HOST_ERROR' });
  });

  window.ccArtifact = { report: report };
})();
