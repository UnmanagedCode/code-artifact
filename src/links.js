export const PLUGIN_ID = 'code-artifact';

/** Where cc mounts this plugin; apps are told their base path from it, since an upgrade or MCP call carries no forwarded prefix. */
export const MOUNT = `/plugins/${PLUGIN_ID}`;
/** The path an app is served under, as the app sees it (no trailing slash). */
export const appBasePath = (id, mount = MOUNT) => `${mount}/app/${id}`;

/** Artifact ids: a slug, never a dot segment, so the deep link passes cc's link validation. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const BASE = `http://cc.internal/#plugin/${PLUGIN_ID}/a`;

/** The deep link to an artifact's latest version, or to version `n` when given. */
export const deepLink = (id, n) => (n === undefined ? `${BASE}/${id}/` : `${BASE}/${id}/v/${n}/`);
