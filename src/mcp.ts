// MCP (Model Context Protocol) over Streamable HTTP: JSON-RPC 2.0 on POST /mcp.
// Modern era first: `server/discover` answers supportedVersions/capabilities/serverInfo;
// the legacy `initialize` + `notifications/initialized` handshake is also supported.
// The six tools act on the same Forge store as REST and GraphQL, and their results carry
// both a text content block and structuredContent, as the suite reads either.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// A frozen, deterministic tool list: tools/list must be byte-identical across calls.
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', enum: Object.freeze(['open', 'closed', 'all']), description: 'Filter by issue state.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

export interface McpResponse {
  status: number;
  body: string | null;
  headers?: Record<string, string>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (!owner || !repoName) throw new Error('owner and repo are required');
  const repo = forge.getRepo(owner, repoName);
  if (!repo) throw new Error(`repository ${owner}/${repoName} not found`);
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (!repoName) throw new Error('name is required');
      const repo = forge.createRepo(
        forge.viewer.login,
        repoName,
        { description: asString(args.description) ?? '', isPrivate: args.private === true },
      );
      if (!repo) throw new Error('Repository already exists on this account');
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      const title = asString(args.title);
      if (!title) throw new Error('title is required');
      const issue = forge.createIssue(repo, title, asString(args.body) ?? '', []);
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      const state = asString(args.state) ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (!title || !head || !base) throw new Error('title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
      const pull = forge.createPull(repo, title, asString(args.body) ?? '', head, base, headSha, baseSha);
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number
        : typeof args.number === 'number' ? args.number
        : typeof args.pullNumber === 'number' ? args.pullNumber : undefined;
      if (number === undefined) throw new Error('pull_number is required');
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`pull request #${number} not found`);
      if (pull.state !== 'open') throw new Error('pull request is not open');
      if (forge.mergeableOf(repo, pull) === 'CONFLICTING') throw new Error('pull request has conflicts');
      const merged = forge.squashMerge(repo, pull);
      if ('conflict' in merged) throw new Error('pull request has conflicts');
      return toolResult(pullJson(forge, repo, pull));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function handleMcp(forge: Forge, bodyText: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const record = asRecord(body);
  const id = 'id' in record ? record.id : undefined;
  const method = asString(record.method);

  // Notifications (no id) are acknowledged with 202 and an empty body.
  if (id === undefined) {
    return { status: 202, body: null };
  }
  if (!method) {
    return rpcError(id, -32600, 'Invalid Request');
  }
  const params = asRecord(record.params);

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case 'initialize': {
      const offered = asString(params.protocolVersion);
      const negotiated = offered && SUPPORTED_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = asString(params.name);
      if (!toolName) return rpcError(id, -32602, 'Invalid params: tool name is required');
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = asRecord(params.arguments);
      try {
        const result = callTool(forge, toolName, args);
        return rpcResult(id, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('Unknown tool')) return rpcError(id, -32602, message);
        // Missing/invalid arguments and runtime failures surface as a tool error,
        // never as an HTTP 500.
        return rpcResult(id, toolError(message));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
