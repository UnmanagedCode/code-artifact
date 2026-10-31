/** Refusal code → REST status. The single source for the MCP and REST surfaces. */
export const CODES = {
  INVALID_ARGUMENT: 400,
  PATH_NOT_ABSOLUTE: 400,
  PATH_NOT_FOUND: 404,
  UNSUPPORTED_SOURCE: 422,
  UNSAFE_ENTRY: 422,
  BAD_ARCHIVE: 422,
  TOO_LARGE: 413,
  KIND_SOURCE_MISMATCH: 422,
  KIND_CHANGE: 409,
  RESERVED_PATH: 422,
  APP_MANIFEST_INVALID: 422,
  NOT_AN_APP: 409,
  PROJECT_REQUIRED: 400,
  PROJECT_UNKNOWN: 404,
  PROJECT_FIXED: 400,
  ARTIFACT_UNKNOWN: 404,
  VERSION_UNKNOWN: 404,
  LAST_VERSION: 409,
  CC_UNREACHABLE: 502,
  STORE_UNCONFIGURED: 503,
  UNSUPPORTED_MEDIA_TYPE: 415,
};

export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    if (!(code in CODES)) throw new Error(`unknown refusal code ${code}`);
    this.name = 'Refusal';
    this.code = code;
    this.status = CODES[code];
  }
}

/** The REST body for a refusal. */
export const refusalBody = (r) => ({ error: r.message, code: r.code });
