// cc steers a page it already shows with `navigate`: a replaceState plus a synthetic popstate, never a load.
// Each document of this plugin shows one route, so when the path changes under it, load the new one.
// A query-only change is the UI's own routing and a hash-only change is an in-page anchor: neither reloads.
(function () {
  var path = location.pathname;
  window.addEventListener('popstate', function () {
    if (location.pathname !== path) location.reload();
  });
})();
