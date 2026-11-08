/** Text views of the MCP tools: pure `(data, args) → string`, each carrying the identifiers a caller acts on. */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const who = (v) => v.sessionLabel ?? v.sessionId ?? 'unknown session';

function ack(lead, d) {
  return [
    lead,
    `link: ${d.link}`,
    `versionLink: ${d.versionLink}`,
    `sessionId: ${d.sessionId ?? 'none'}`,
    `bytes: ${d.bytes}, files: ${d.files}`,
    ...(d.app ? [`app.status: ${d.app.status}`] : []),
  ].join('\n');
}

const appLine = (app) => `app.status: ${app.status}${app.version == null ? '' : `, version ${app.version}`}${app.error ? `, error: ${app.error}` : ''}, since ${app.since}`;

export const views = {
  publish: (d) => ack(`Published artifact ${d.id} (version ${d.version}): "${d.title}", ${d.kind}, project ${d.project}.`, d),

  update: (d) => ack(`Published version ${d.version} of artifact ${d.id}: "${d.title}", ${d.kind}, project ${d.project}.`, d),

  list({ artifacts }, args) {
    const scope = `${args.project ? ` in project ${args.project}` : ''}${args.kind ? ` of kind ${args.kind}` : ''}`;
    if (artifacts.length === 0) return `No artifacts${scope}.`;
    const rows = artifacts.map((a) => {
      const v = a.versions[a.versions.length - 1];
      return `${a.id}  "${a.title}"  ${a.kind}  project ${a.project}  latest v${v.n} (${plural(a.versions.length, 'version')}), ${v.publishedAt}, by ${who(v)}${a.app ? `  app.status ${a.app.status}` : ''}  ${a.link}`;
    });
    return [`${plural(artifacts.length, 'artifact')}${scope}, newest first. Each line shows the latest version only; get_artifact lists every version.`, ...rows].join('\n');
  },

  get(r) {
    const rows = r.versions.map((v) => `v${v.n}  ${v.publishedAt}  "${v.title}"  source ${v.source.name} (${v.source.type})${v.file ? `  file ${v.file}` : ''}  bytes: ${v.bytes}, files: ${v.files}  by ${who(v)}  ${v.versionLink}`);
    return [
      `"${r.title}": ${r.kind} artifact ${r.id}, project ${r.project}, created ${r.createdAt}.`,
      `link: ${r.link}`,
      ...(r.app ? [appLine(r.app)] : []),
      `${plural(r.versions.length, 'version')}, oldest first:`,
      ...rows,
    ].join('\n');
  },

  remove: (d) => (d.deleted === 'artifact'
    ? `Deleted artifact ${d.id} and every version of it.`
    : `Deleted version ${d.version} of artifact ${d.id}; the latest version is now ${d.latest}.`),
};
