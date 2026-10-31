export const PLUGIN_ID = 'code-artifact';

/** Artifact ids: a slug, never a dot segment, so the deep link passes cc's link validation. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const BASE = `http://cc.internal/#plugin/${PLUGIN_ID}/a`;

/** The deep link to an artifact's latest version, or to version `n` when given. */
export const deepLink = (id, n) => (n === undefined ? `${BASE}/${id}/` : `${BASE}/${id}/v/${n}/`);
