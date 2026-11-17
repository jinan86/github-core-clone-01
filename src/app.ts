// The HTTP server: one process serving git smart HTTP, REST v3, GraphQL and MCP on the
// same Forge store. Every route except /healthz requires `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN` and answers 401 JSON without it, as the suite demands.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest, parseJsonBody, requestIdHeader } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else requires the shop token, exactly as a Bearer token.
  const authorization = req.headers.authorization ?? '';
  if (authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': requestIdHeader() });
    return;
  }

  const host = req.headers.host ?? '127.0.0.1';
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  // ---- REST v3 ----
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/');
    let parsedBody: unknown = {};
    if (needsBody && body.length > 0) {
      const parsed = parseJsonBody(body.toString('utf8'));
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestIdHeader() });
        return;
      }
      parsedBody = parsed.value;
    }
    const result = await handleRest({ forge, method, segments, query: queryOf(req), host, body: parsedBody });
    const headers: Record<string, string> = {
      'x-github-request-id': requestIdHeader(),
      'x-oauth-scopes': 'repo, read:org',
      ...(result.headers ?? {}),
    };
    if (result.status === 204 || result.body === null) {
      res.writeHead(result.status, headers);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, headers);
    return;
  }

  // ---- GraphQL ----
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(forge, parsed), { 'x-github-request-id': requestIdHeader() });
    return;
  }

  // ---- MCP ----
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const result = handleMcp(forge, body.toString('utf8'));
    if (result.body === null) {
      res.writeHead(result.status, result.headers ?? {});
      res.end();
      return;
    }
    const text = result.body;
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...(result.headers ?? {}) });
    res.end(text);
    return;
  }

  // ---- git smart HTTP ----
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1] as string);
    const repoName = decodeSegment(gitMatch[2] as string);
    const action = gitMatch[3] as string;
    const repo = forge.getRepo(owner, repoName);
    const wantsV2 = req.headers['git-protocol'] === 'version=2';
    if (action === 'info/refs') {
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const service = queryOf(req).get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'service is required' });
        return;
      }
      const result = handleInfoRefs(repo, service, wantsV2);
      if (result.contentType.startsWith('application/json')) sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
      else sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (action === 'git-upload-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const result = handleUploadPack(repo, body, wantsV2);
      if (result.contentType.startsWith('application/json')) sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
      else sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (action === 'git-receive-pack') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const result = handleReceivePack(forge, repo, body);
      if (result.contentType.startsWith('application/json')) sendJson(res, result.status, JSON.parse(result.body.toString('utf8')) as unknown);
      else sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
  }

  // Everything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestIdHeader() });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(forge: Forge = new Forge(), token: string = process.env.MAKEFUN_SHOP_TOKEN ?? 'dev-token'): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(forge, token, req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      process.stderr.write(`[app] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
}
