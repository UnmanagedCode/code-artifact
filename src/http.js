import http from 'node:http';
import { Refusal, refusalBody } from './refusal.js';

/** Express 4 does not catch a rejected handler promise; this forwards it to `next`. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Answers a refusal as JSON (`{error, code}` with its status); anything else goes on to the terminal handler. */
export function refusalJson(err, _req, res, next) {
  if (!(err instanceof Refusal)) return next(err);
  return res.status(err.status).json(refusalBody(err));
}

/** Plain-text answer for status `status`, never echoing an error message (it can carry a path). */
export const plain = (res, status, text = http.STATUS_CODES[status] ?? 'Error') => res.status(status).type('text/plain').send(text);
