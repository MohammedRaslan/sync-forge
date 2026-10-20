/**
 * GETs JSON from one HTTP API with the connection's headers and auth: same-origin redirects only, a timeout,
 * bounded retries on 429/503, request spacing shared per API, and a response size cap enforced while reading.
 * Errors name the endpoint, status and URL (API key masked); never headers, the body or the secret.
 */
import { STATUS_CODES } from 'node:http';
import { UpstreamError, ValidationError } from '../../common/errors';
import { HttpConfig } from '../../connections/connection.model';
import { isSendableHeaderValue, maskedUrl, retryAfterMs, sameOrigin, unsafeIntegerIn } from './http-format';
import { Clock, RequestSpacer } from './request-spacer';

/** Same-origin redirects followed per request; more usually means a loop. */
const MAX_REDIRECTS = 3;
/** Longest wait for one request, from sending it to the last byte of its body. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Retries of a 429 or 503 before giving up. */
export const MAX_RETRIES = 3;
/** First retry wait without a Retry-After header; doubles on each retry. */
const BASE_RETRY_MS = 1000;
/** Longest Retry-After Syncforge waits out; a longer one fails the request instead of stalling a run. */
export const MAX_RETRY_WAIT_MS = 120_000;
/** Content types and status texts are server text: shown, but cut short. */
const MAX_TEXT_SHOWN = 100;
const BYTES_PER_MB = 1024 * 1024;

/** Statuses that mean "too busy, try again". Other 5xx usually do not get better by retrying. */
const RETRY_STATUSES = new Set([429, 503]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** What the client needs from a connection. */
export type HttpClientConfig = Pick<HttpConfig, 'baseUrl' | 'auth' | 'secret' | 'headers' | 'minIntervalSeconds'> & {
  maxResponseBytes: number;
};

/** A parsed JSON response. */
export interface HttpJsonResponse {
  status: number;
  headers: Headers;
  body: unknown;
  bytes: number;
}

/** One request as it came back, whatever its status: what a probe shows. */
export interface HttpProbeResponse {
  status: number;
  headers: Headers;
  contentType: string | null;
  bytes: number;
  latencyMs: number;
  /** The parsed body of a 2xx response; undefined for any other status, whose body is not read as data. */
  body: unknown;
}

export interface GetOptions {
  signal?: AbortSignal;
  /** Retries of a 429 or 503; {@link MAX_RETRIES} by default, 0 to fail fast. */
  maxRetries?: number;
}

/** A response with its body still unread, and the signal that keeps watching the body read. */
interface Sent {
  response: Response;
  url: string;
  timeout: AbortSignal;
}

export class HttpClient {
  private readonly origin: string;

  constructor(
    private readonly config: HttpClientConfig,
    private readonly spacer: RequestSpacer,
    private readonly clock: Clock = Date.now,
  ) {
    this.origin = new URL(config.baseUrl).origin;
  }

  /**
   * The JSON body at `url`. Retries a 429 or 503, waiting for its Retry-After (or 1 s, 2 s, 4 s); the wait
   * also holds back every other request to this API. Any other non-2xx status is an error.
   */
  async get(endpoint: string, url: string, options: GetOptions = {}): Promise<HttpJsonResponse> {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    for (let attempt = 0; ; attempt += 1) {
      const sent = await this.send(endpoint, url, options.signal);
      const { response } = sent;
      if (RETRY_STATUSES.has(response.status) && attempt < maxRetries) {
        await discardBody(response);
        this.spacer.pushBack(this.clock() + this.retryWaitMs(endpoint, sent, attempt));
        continue;
      }
      if (!response.ok) {
        await discardBody(response);
        throw this.statusError(endpoint, sent, attempt > 0 ? ` after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}` : '');
      }
      const bytes = await this.readBody(endpoint, sent, options.signal);
      return { status: response.status, headers: response.headers, body: this.parseJson(endpoint, sent, bytes), bytes: bytes.length };
    }
  }

  /**
   * One request, no retry, returned whatever its status, so a 401 or 429 can be shown with its rate-limit
   * headers. Only a 2xx body is parsed. Network failures, redirects elsewhere and oversized bodies still throw.
   */
  async probe(endpoint: string, url: string, signal?: AbortSignal): Promise<HttpProbeResponse> {
    const started = this.clock();
    const sent = await this.send(endpoint, url, signal);
    const { response } = sent;
    const bytes = await this.readBody(endpoint, sent, signal);
    return {
      status: response.status,
      headers: response.headers,
      contentType: response.headers.get('content-type'),
      bytes: bytes.length,
      latencyMs: this.clock() - started,
      body: response.ok ? this.parseJson(endpoint, sent, bytes) : undefined,
    };
  }

  /** Sends the request and follows same-origin redirects; the body is left unread. */
  private async send(endpoint: string, url: string, signal: AbortSignal | undefined): Promise<Sent> {
    // Built before any request, so a header that cannot be sent is a settings error, never "could not reach".
    const headers = this.requestHeaders(endpoint);
    let current = url;
    for (let redirects = 0; ; redirects += 1) {
      // Every request takes a turn, redirects and retries included: the API counts them all.
      await this.spacer.wait(this.config.minIntervalSeconds * 1000, signal);
      // Started after the turn, so time spent waiting for it never counts against the request.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await this.fetchOnce(endpoint, current, headers, requestSignal, { signal, timeout });
      if (!REDIRECT_STATUSES.has(response.status)) return { response, url: current, timeout };
      await discardBody(response);
      current = this.redirectTarget(endpoint, current, response, redirects);
    }
  }

  private async fetchOnce(
    endpoint: string,
    url: string,
    headers: Headers,
    requestSignal: AbortSignal,
    watched: { signal?: AbortSignal; timeout: AbortSignal },
  ): Promise<Response> {
    try {
      // Manual redirects: fetch would otherwise follow one to another host with the Authorization header.
      return await fetch(this.withApiKey(url), { method: 'GET', headers, redirect: 'manual', signal: requestSignal });
    } catch (error) {
      throw this.networkError(endpoint, url, error, watched);
    }
  }

  /** The URL a redirect points to; refuses another origin, a missing Location and too many hops. */
  private redirectTarget(endpoint: string, current: string, response: Response, redirects: number): string {
    const from = `GET ${this.shown(current)}`;
    const location = response.headers.get('location');
    if (!location) throw new UpstreamError(`Endpoint "${endpoint}": HTTP ${response.status} redirect without a Location header from ${from}`);
    if (redirects >= MAX_REDIRECTS) throw new UpstreamError(`Endpoint "${endpoint}": more than ${MAX_REDIRECTS} redirects from ${from}`);
    let target: URL;
    try {
      target = new URL(location, current);
    } catch {
      throw new UpstreamError(`Endpoint "${endpoint}": ${from} redirected to something that is not a URL`);
    }
    if (!sameOrigin(target.toString(), this.config.baseUrl)) {
      // Only the origin is named: the rest of the address may carry a token.
      throw new ValidationError(
        `Endpoint "${endpoint}": ${from} redirected to another origin (${target.origin}). Only redirects within ${this.origin} are followed, so credentials never leave it; set the base URL to the address the API redirects to`,
      );
    }
    return target.toString();
  }

  /** How long to wait before retrying a 429/503, or an error when the API asks for longer than Syncforge waits. */
  private retryWaitMs(endpoint: string, sent: Sent, attempt: number): number {
    const asked = retryAfterMs(sent.response.headers.get('retry-after'), this.clock());
    const waitMs = asked ?? BASE_RETRY_MS * 2 ** attempt;
    if (waitMs > MAX_RETRY_WAIT_MS) {
      throw new UpstreamError(
        `${this.statusError(endpoint, sent, '').message}: the API asks to wait ${Math.ceil(waitMs / 1000)} s, longer than the ${MAX_RETRY_WAIT_MS / 1000} s Syncforge waits. Try again later, or set a longer interval between requests`,
      );
    }
    return waitMs;
  }

  /** Reads the body, refusing it as soon as it is over the size limit (by Content-Length, then by counting). */
  private async readBody(endpoint: string, sent: Sent, signal: AbortSignal | undefined): Promise<Buffer> {
    const { response } = sent;
    const limit = this.config.maxResponseBytes;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await discardBody(response);
      throw this.sizeError(endpoint, sent.url);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        total += chunk.value.length;
        if (total > limit) {
          // Cancelling closes the connection, so the rest of the body is never downloaded. Cleanup only.
          await reader.cancel().catch(() => undefined);
          throw this.sizeError(endpoint, sent.url);
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw this.networkError(endpoint, sent.url, error, { signal, timeout: sent.timeout });
    }
    return Buffer.concat(chunks, total);
  }

  private parseJson(endpoint: string, sent: Sent, bytes: Buffer): unknown {
    const contentType = sent.response.headers.get('content-type');
    const described = contentType ? `content-type ${contentType.slice(0, MAX_TEXT_SHOWN)}` : 'no content-type';
    const from = `the response from GET ${this.shown(sent.url)}`;
    let text: string;
    try {
      // Fatal: a body that is not UTF-8 is refused rather than read with replacement characters.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new UpstreamError(`Endpoint "${endpoint}": ${from} is not UTF-8 text (${described})`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UpstreamError(`Endpoint "${endpoint}": ${from} is not JSON (${described})`);
    }
    // The number is not quoted: it is usually an ID, and response values stay out of errors and logs.
    if (unsafeIntegerIn(text) !== undefined) {
      throw new UpstreamError(
        `Endpoint "${endpoint}": ${from} holds a whole number larger than JavaScript can keep exactly (above 9007199254740991). Ask the API to send such IDs as strings`,
      );
    }
    return body;
  }

  /**
   * The headers of every request. A value fetch cannot send is refused naming the header or credential, never
   * the value, and without the platform error as cause (its message quotes the value).
   */
  private requestHeaders(endpoint: string): Headers {
    // Accept first, so a user header (e.g. a vendor media type) can replace it; auth last, so nothing can.
    const headers = new Headers({ Accept: 'application/json' });
    for (const { name, value } of this.config.headers) {
      setHeader(headers, endpoint, name, value, `Endpoint "${endpoint}": the value of header "${name}" contains characters that cannot be sent in an HTTP header`);
    }
    const { auth, secret } = this.config;
    const badSecret = (what: string) => `Endpoint "${endpoint}": the ${what} contains characters that cannot be sent in an HTTP header. Paste it again in the connection settings`;
    switch (auth.type) {
      case 'bearer':
        setHeader(headers, endpoint, 'Authorization', `Bearer ${secret}`, badSecret('token'));
        break;
      case 'basic':
        // Base64 can always be sent, whatever the username and password hold.
        headers.set('Authorization', `Basic ${Buffer.from(`${auth.username}:${secret}`, 'utf8').toString('base64')}`);
        break;
      case 'apiKeyHeader':
        setHeader(headers, endpoint, auth.header, secret, badSecret('API key'));
        break;
      default:
        break;
    }
    return headers;
  }

  /** `url` with the API key query parameter set last, so no other parameter of that name replaces it. */
  private withApiKey(url: string): string {
    const { auth, secret } = this.config;
    if (auth.type !== 'apiKeyQuery') return url;
    const parsed = new URL(url);
    parsed.searchParams.set(auth.param, secret);
    return parsed.toString();
  }

  /** A URL as errors show it: as sent, with the API key masked. */
  private shown(url: string): string {
    return maskedUrl(this.withApiKey(url), this.config.auth);
  }

  private statusError(endpoint: string, sent: Sent, suffix: string): UpstreamError {
    const status = sent.response.status;
    // The standard text, not the server's reason phrase, which is server-chosen text.
    const text = STATUS_CODES[status] ?? 'Unknown status';
    const hint = status === 401 || status === 403 ? '; check the authentication settings' : '';
    return new UpstreamError(`Endpoint "${endpoint}": HTTP ${status} ${text} from GET ${this.shown(sent.url)}${suffix}${hint}`);
  }

  private sizeError(endpoint: string, url: string): ValidationError {
    return new ValidationError(
      `Endpoint "${endpoint}": the response from GET ${this.shown(url)} is larger than ${sizeText(this.config.maxResponseBytes)}, the response size limit. Ask for smaller pages, or raise the limit in Settings`,
    );
  }

  /** A failed fetch or body read as an error a user can act on; a cancelled run rethrows the cancel. */
  private networkError(endpoint: string, url: string, error: unknown, watched: { signal?: AbortSignal; timeout: AbortSignal }): unknown {
    if (watched.signal?.aborted) return watched.signal.reason;
    const target = `GET ${this.shown(url)}`;
    if (watched.timeout.aborted) {
      return new UpstreamError(`Endpoint "${endpoint}": no response from ${target} within ${REQUEST_TIMEOUT_MS / 1000} s`, error);
    }
    const code = errorCode(error);
    const host = new URL(url).host;
    return new UpstreamError(`Endpoint "${endpoint}": ${target} failed: ${networkReason(code, host)}${this.dockerHint(code, url)}`, error);
  }

  /** Inside Docker, localhost is the container itself, the most common reason a local API refuses. */
  private dockerHint(code: string | undefined, url: string): string {
    if (code !== 'ECONNREFUSED' || !LOOPBACK_HOSTS.has(new URL(url).hostname)) return '';
    return '. If Syncforge runs in Docker, use host.docker.internal instead of localhost for an API on this machine';
  }
}

/**
 * Sets a header, or throws `refusal` when fetch cannot send the value. The value is checked first, so the
 * platform error (whose message quotes the value, maybe a credential) is never what reaches the user.
 */
function setHeader(headers: Headers, endpoint: string, name: string, value: string, refusal: string): void {
  if (!isSendableHeaderValue(value)) throw new ValidationError(refusal);
  try {
    headers.set(name, value);
  } catch {
    // The value passed the check above, so the name is what fetch refused (possible in a hand-edited script).
    throw new ValidationError(`Endpoint "${endpoint}": "${name.slice(0, MAX_TEXT_SHOWN)}" is not a valid HTTP header name`);
  }
}

/** The system error code behind a fetch failure (fetch wraps it as `cause`), if any. */
function errorCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 3; current = current.cause, depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function networkReason(code: string | undefined, host: string): string {
  switch (code) {
    case 'ECONNREFUSED':
      return `connection refused by ${host}. Is the API running, and is the base URL right?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `host ${host} not found. Check the base URL and this machine's network`;
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return `${host} closed the connection`;
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return `could not connect to ${host} in time`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `the TLS certificate of ${host} is not trusted (${code})`;
    default:
      return code ? `could not reach ${host} (${code})` : `could not reach ${host}`;
  }
}

/** A size limit as text: whole megabytes as set in Settings, or bytes for a smaller limit. */
export function sizeText(bytes: number): string {
  return bytes >= BYTES_PER_MB ? `${Math.round((bytes / BYTES_PER_MB) * 100) / 100} MB` : `${bytes} bytes`;
}

/** Lets go of a body that will not be read, so the connection is freed. Cleanup only. */
async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
