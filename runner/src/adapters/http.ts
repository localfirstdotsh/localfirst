import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { request as httpsRequest } from 'node:https';
import { loopbackEndpointSchema } from '@localfirst/contracts';
import { AdapterError } from './types.js';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface LoopbackClientOptions {
  /** The explicitly approved endpoint, e.g. `http://127.0.0.1:11434`. */
  endpoint: string;
  /** Optional bearer token, kept in memory and sent only to the approved endpoint. */
  credential?: string;
  maxResponseBytes?: number;
}

export interface LoopbackRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  signal: AbortSignal;
}

export interface LoopbackResponse {
  status: number;
  /** Parsed JSON body, or `null` when the body was empty. */
  json: unknown;
}

/**
 * The only network path a runtime adapter uses. It talks to one approved
 * loopback origin: no redirects, no environment or global proxy, no other host,
 * and the connected peer must itself be a loopback address. Responses are size
 * bounded and must be JSON. Nothing is logged.
 */
export class LoopbackClient {
  readonly endpoint: string;
  private readonly url: URL;
  private readonly credential: string | undefined;
  private readonly maxBytes: number;

  constructor(options: LoopbackClientOptions) {
    if (!loopbackEndpointSchema.safeParse(options.endpoint).success) {
      throw new AdapterError('endpoint_not_loopback', 'runtime endpoint must be an approved loopback URL');
    }
    this.url = new URL(options.endpoint);
    this.endpoint = this.url.origin;
    this.credential = options.credential;
    this.maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  }

  /** One bounded JSON request/response. */
  request(input: LoopbackRequest): Promise<LoopbackResponse> {
    return this.dispatch(input, 'application/json', (res, status, req, resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBytes) {
          req.destroy();
          reject(new AdapterError('response_too_large', 'runtime response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => reject(new AdapterError('connection_error', 'response stream failed')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.length === 0) return resolve({ status, json: null });
        try {
          resolve({ status, json: JSON.parse(text) });
        } catch {
          reject(new AdapterError('malformed_response', 'runtime response was not valid JSON'));
        }
      });
    });
  }

  /**
   * A streamed request. A 2xx body is delivered line by line to `onLine` as it
   * arrives (NDJSON or server-sent events) and resolves with `json: null` once
   * it ends; the whole stream is size bounded. Any other status is buffered and
   * parsed like `request`, so error handling is the same.
   */
  stream(input: LoopbackRequest, accept: string, onLine: (line: string) => void): Promise<LoopbackResponse> {
    return this.dispatch(input, accept, (res, status, req, resolve, reject) => {
      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxBytes) {
            req.destroy();
            reject(new AdapterError('response_too_large', 'runtime response exceeded the size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => reject(new AdapterError('connection_error', 'response stream failed')));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (text.length === 0) return resolve({ status, json: null });
          try {
            resolve({ status, json: JSON.parse(text) });
          } catch {
            reject(new AdapterError('malformed_response', 'runtime response was not valid JSON'));
          }
        });
        return;
      }
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let size = 0;
      let failed = false;
      const fail = (error: AdapterError) => {
        if (failed) return;
        failed = true;
        req.destroy();
        reject(error);
      };
      const emit = (line: string) => {
        if (failed) return;
        try {
          onLine(line);
        } catch (cause) {
          fail(cause instanceof AdapterError ? cause : new AdapterError('malformed_response', 'runtime stream could not be read'));
        }
      };
      res.on('data', (chunk: Buffer) => {
        if (failed) return;
        size += chunk.length;
        if (size > this.maxBytes) return fail(new AdapterError('response_too_large', 'runtime response exceeded the size limit'));
        pending += decoder.write(chunk);
        let newline = pending.indexOf('\n');
        while (newline >= 0 && !failed) {
          emit(pending.slice(0, newline).replace(/\r$/, ''));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
        if (pending.length > this.maxBytes) fail(new AdapterError('response_too_large', 'runtime stream line exceeded the size limit'));
      });
      res.on('error', () => fail(new AdapterError('connection_error', 'response stream failed')));
      res.on('end', () => {
        if (failed) return;
        pending += decoder.end();
        if (pending.length > 0) emit(pending.replace(/\r$/, ''));
        if (!failed) resolve({ status, json: null });
      });
    });
  }

  /** Shared guards: approved origin only, no redirects, no proxies, loopback peer only. */
  private dispatch(
    input: LoopbackRequest,
    accept: string,
    handle: (
      res: IncomingMessage,
      status: number,
      req: ClientRequest,
      resolve: (value: LoopbackResponse) => void,
      reject: (reason: AdapterError) => void,
    ) => void,
  ): Promise<LoopbackResponse> {
    if (!input.path.startsWith('/') || input.path.startsWith('//') || input.path.includes('\\')) {
      return Promise.reject(new AdapterError('invalid_path', 'request path must be an absolute path'));
    }
    const target = new URL(input.path, this.url);
    if (target.origin !== this.endpoint) {
      return Promise.reject(new AdapterError('origin_mismatch', 'request would leave the approved endpoint'));
    }
    if (input.signal.aborted) return Promise.reject(new AdapterError('aborted', 'request aborted'));

    const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8');
    const headers: Record<string, string> = { accept };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (this.credential) headers.authorization = `Bearer ${this.credential}`;

    return new Promise((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      // `agent: false` bypasses any global agent; node:http never reads proxy environment variables.
      const req = send(
        target,
        { method: input.method, headers, agent: false, signal: input.signal },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            reject(new AdapterError('redirect_rejected', `runtime answered with redirect ${status}`));
            return;
          }
          handle(res, status, req, resolve, reject);
        },
      );
      req.on('socket', (socket) => {
        socket.on('connect', () => {
          const peer = socket.remoteAddress ?? '';
          if (!LOOPBACK_PEERS.has(peer)) {
            req.destroy();
            reject(new AdapterError('non_loopback_peer', 'connected peer is not a loopback address'));
          }
        });
      });
      req.on('error', (cause) => {
        if (input.signal.aborted) reject(new AdapterError('aborted', 'request aborted'));
        else reject(new AdapterError('connection_error', (cause as NodeJS.ErrnoException).code ?? 'connection failed'));
      });
      req.end(payload);
    });
  }
}
