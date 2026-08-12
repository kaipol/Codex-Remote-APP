/**
 * Interactive sending intentionally remains unavailable until a tested Codex
 * app-server JSON-RPC transport can resume the discovered thread id.
 */
export class CodexTransportUnavailableError extends Error {
  readonly status = 501;
  constructor() { super('Codex app-server thread resume/turn is not available in this phase'); }
}
