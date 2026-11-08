import { Refusal, refusalBody } from './refusal.js';
import { views } from './mcpText.js';

const FORMATS = ['text', 'json'];

/**
 * The MCP tools, keyed by the manifest's tool names: `run(args, caller)` returns the complete data (the json reply),
 * `text(data, args)` renders it as prose for agents.
 */
export function createTools(ops) {
  return {
    publish_artifact: { run: (args, caller) => ops.publish(args, caller), text: views.publish },
    update_artifact: { run: (args, caller) => ops.update(args, caller), text: views.update },
    list_artifacts: { run: (args) => ops.list(args), text: views.list },
    get_artifact: { run: (args) => ops.get(args), text: views.get },
    delete_artifact: { run: (args) => ops.remove(args), text: views.remove },
  };
}

/**
 * Handles one MCP envelope `{tool, arguments, caller, format}`. `format` is "json" or "text" (absent means text: a cc that
 * predates typed tools never sends it). A well-formed call answers 200: `{structured}` (json), `{text}` (text), or a
 * refusal `{error, code, details?}` in either format. A malformed envelope or an unknown format is 400.
 */
export async function handle(tools, envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.tool !== 'string') {
    return { status: 400, body: { error: 'malformed envelope: expected {tool, arguments, caller, format}' } };
  }
  const { tool, arguments: args = {}, caller = {}, format = 'text' } = envelope;
  if (!FORMATS.includes(format)) return { status: 400, body: { error: 'format must be "text" or "json"' } };
  if (!Object.hasOwn(tools, tool)) return { status: 200, body: refusalBody(new Refusal('TOOL_UNKNOWN', `unknown tool ${tool}`)) };
  try {
    const data = await tools[tool].run(args, caller ?? {});
    return { status: 200, body: format === 'json' ? { structured: data } : { text: tools[tool].text(data, args) } };
  } catch (e) {
    if (e instanceof Refusal) return { status: 200, body: refusalBody(e) };
    console.error(`code-artifact: ${tool} failed:`, e);
    return { status: 200, body: refusalBody(new Refusal('INTERNAL', 'internal error')) };
  }
}
