// cc steers a page it already shows with `navigate`: a replaceState plus a synthetic popstate, never a load.
// Each document of this plugin shows one route, so when the path changes under it, load the new one.
// A hash-only change is an in-page anchor and never reloads. A query-only change is the UI's own routing there,
// but a server-rendered page (its <html> carries data-reload-on-search) shows what its query selects, so it reloads.
(function () {
  var withSearch = document.documentElement.hasAttribute('data-reload-on-search');
  var where = function () { return location.pathname + (withSearch ? location.search : ''); };
  var loaded = where();
  window.addEventListener('popstate', function () {
    if (where() !== loaded) location.reload();
  });
})();
