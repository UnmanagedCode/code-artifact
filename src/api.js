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
  const appArgs = (req) => ({ artifact: req.params.id });
  r.get('/apps/:id', wrap(async (req, res) => res.json(await ops.appStatus(appArgs(req)))));
  r.post('/apps/:id/start', wrap(async (req, res) => res.status(202).json(await ops.appStart(appArgs(req)))));
  r.post('/apps/:id/stop', wrap(async (req, res) => res.json(await ops.appStop(appArgs(req)))));
  r.get('/apps/:id/log', wrap(async (req, res) => {
    const { bytes } = req.query;
    const text = await ops.appLog({ ...appArgs(req), ...(bytes !== undefined && { bytes: /^[0-9]+$/.test(bytes) ? Number(bytes) : NaN }) });
    res.set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(text);
  }));
  r.post('/prune', wrap(async (req, res) => res.json(await ops.prune(req.body ?? {}))));

  r.use(refusalJson);
  return r;
}
