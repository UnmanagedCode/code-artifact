/** Ingest caps: total bytes, total files (entries), and the markdown source size. Injectable for tests. */
export const LIMITS = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 20_000,
  maxMarkdownBytes: 4 * 1024 * 1024,
});
