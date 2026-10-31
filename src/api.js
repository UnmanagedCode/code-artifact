import express from 'express';
import { refusalJson, wrap } from './http.js';

/** The REST API behind the UI; thin wrappers over the shared ops. */
export function apiRouter({ ops, tools, handleMcp }) {
  const r = express.Router();
  r.use(express.json());

  r.get('/health', (_req, res) => res.json({ ok: true }));

  r.post('/mcp', wrap(async (req, res) => {
    const { status, body } = await handleMcp(tools, req.body);
    res.status(status).json(body);
  }));

  r.get('/artifacts', wrap(async (req, res) => {
    const { project, kind } = req.query;
    res.json(await ops.list({ ...(project !== undefined && { project }), ...(kind !== undefined && { kind }) }));
  }));
  r.get('/artifacts/:id', wrap(async (req, res) => res.json(await ops.get({ artifact: req.params.id }))));
  r.delete('/artifacts/:id', wrap(async (req, res) => res.json(await ops.remove({ artifact: req.params.id }))));
  r.delete('/artifacts/:id/versions/:n', wrap(async (req, res) => {
    res.json(await ops.remove({ artifact: req.params.id, version: /^[0-9]+$/.test(req.params.n) ? Number(req.params.n) : NaN }));
  }));
  r.post('/prune', wrap(async (req, res) => res.json(await ops.prune(req.body ?? {}))));

  r.use(refusalJson);
  return r;
}
