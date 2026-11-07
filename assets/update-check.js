// Update notice on a latest-URL page: polls the artifact's record while the page is visible and offers a switch when the shown version is no longer the latest.
(function () {
  var POLL_MS = 10000;
  var body = document.body;
  var api = body.getAttribute('data-update-api');
  var notice = document.querySelector('[data-role="update"]');
  if (!api || !notice) return;
  var shown = Number(body.getAttribute('data-shown-version'));
  var timer = null;
  var done = false;
  var generation = 0;
  var rendered = '';

  function schedule() {
    clearTimeout(timer);
    timer = done ? null : setTimeout(tick, POLL_MS);
  }

  // Only a change of state or target version touches the DOM: the button, its focus and the live-region announcement survive unchanged polls.
  function render(state, latest, text, buttonText) {
    var key = state + ':' + latest;
    if (key === rendered) return;
    rendered = key;
    while (notice.firstChild) notice.removeChild(notice.firstChild);
    // Nothing at all when current, so the stylesheet's :empty hides the region.
    if (!text) return;
    var span = document.createElement('span');
    span.textContent = text;
    notice.appendChild(span);
    if (!buttonText) return;
    var button = document.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('class', 'btn primary');
    button.textContent = buttonText;
    // The latest URL is never cached: the reload shows whatever is latest at click time.
    button.addEventListener('click', function () { location.reload(); });
    notice.appendChild(button);
  }

  function decide(status, data) {
    if (status === 404 && data && data.code === 'ARTIFACT_UNKNOWN') {
      done = true;
      render('artifactGone', 0, 'This artifact was deleted.');
      return;
    }
    if (status !== 200 || !data || !data.versions || !data.versions.length) return;
    var latest = data.versions[data.versions.length - 1].n;
    var present = data.versions.some(function (v) { return v.n === shown; });
    if (!present) render('versionGone', latest, 'v' + shown + ' was deleted.', 'View v' + latest);
    else if (latest !== shown) render('newer', latest, 'Updated to v' + latest + '.', 'View update');
    else render('current', latest, '');
  }

  function tick() {
    timer = null;
    if (document.hidden) return;
    // A request in flight cannot be cancelled: only the newest one's outcome is applied or schedules the next poll.
    var mine = ++generation;
    var current = function () { return mine === generation && !done; };
    fetch(api, { cache: 'no-store' })
      .then(function (res) {
        return res.json().then(function (data) { if (current()) decide(res.status, data); }, function () {});
      })
      .catch(function () {})
      .then(function () { if (current()) schedule(); });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || done) return;
    clearTimeout(timer);
    tick();
  });
  schedule();
})();
