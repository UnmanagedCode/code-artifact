import { Refusal } from './refusal.js';

/** `{summary}` shape of list_artifacts: one row per artifact, latest version only. */
const summarize = (r) => {
  const v = r.versions[r.versions.length - 1];
  return {
    id: r.id, title: r.title, kind: r.kind, project: r.project, versions: r.versions.length,
    latest: { version: v.n, publishedAt: v.publishedAt, sessionId: v.sessionId, sessionLabel: v.sessionLabel },
    link: r.link,
  };
};

/** The MCP tool handlers, keyed by the manifest's tool names. */
export function createTools(ops) {
  return {
    publish_artifact: (args, caller) => ops.publish(args, caller),
    update_artifact: (args, caller) => ops.update(args, caller),
    list_artifacts: async (args) => ({ artifacts: (await ops.list(args)).artifacts.map(summarize) }),
    get_artifact: (args) => ops.get(args),
    delete_artifact: (args) => ops.remove(args),
  };
}

/**
 * Handles one MCP envelope `{tool, arguments, caller}`. Every well-formed call answers 200:
 * `{result}`, or `{error: "<CODE>: <message>"}` (MCP errors are plain strings, so the code is the prefix).
 */
export async function handle(tools, envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.tool !== 'string') {
    return { status: 400, body: { error: 'malformed envelope: expected {tool, arguments, caller}' } };
  }
  const { tool, arguments: args = {}, caller = {} } = envelope;
  if (!Object.hasOwn(tools, tool)) return { status: 200, body: { error: `unknown tool ${tool}` } };
  try {
    return { status: 200, body: { result: await tools[tool](args, caller ?? {}) } };
  } catch (e) {
    if (e instanceof Refusal) return { status: 200, body: { error: `${e.code}: ${e.message}` } };
    console.error(`code-artifact: ${tool} failed:`, e);
    return { status: 200, body: { error: 'internal error' } };
  }
}
