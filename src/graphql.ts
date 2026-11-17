// A minimal GraphQL executor for the exact documents the suite sends (checks-graphql.ts):
// a hand-rolled lexer/parser, resolvers over the shared Forge store, Relay global ids,
// __type introspection for Issue/PullRequest/Repository/SearchType, node(id:), and
// batched operation arrays. Unknown fields answer HTTP 200 with an errors array whose
// message names the field, exactly as the suite expects.

import { cursorOf, globalId, indexOfCursor, parseGlobalId } from './util.ts';
import { SCENARIO_USERS } from './scenario.ts';
import {
  type Forge,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
  type ScenarioUser,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// lexer / parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface VariableDefinition {
  name: string;
  defaultValue?: ValueNode;
}

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: VariableDefinition[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class GraphQLSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          end += 2;
        } else {
          value += source[end] as string;
          end += 1;
        }
      }
      if (end >= source.length) throw new GraphQLSyntaxError('unterminated string');
      tokens.push(JSON.stringify(value));
      index = end + 1;
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      if (!match) throw new GraphQLSyntaxError(`bad number at ${index}`);
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
      if (!match) throw new GraphQLSyntaxError(`bad name at ${index}`);
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw new GraphQLSyntaxError('unexpected end of document');
    this.position += 1;
    return token;
  }

  private expect(token: string): void {
    const actual = this.next();
    if (actual !== token) throw new GraphQLSyntaxError(`expected ${token}, got ${actual}`);
  }

  private isName(token: string | undefined): boolean {
    return token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && !/^-?\d/.test(token);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.position < this.tokens.length) {
      const token = this.next();
      if (token === 'fragment') {
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        let name: string | undefined;
        if (this.isName(this.peek())) name = this.next();
        const variableDefinitions = this.parseVariableDefinitions();
        operations.push({ operation: token, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
      } else if (token === '{') {
        this.position -= 1;
        operations.push({ operation: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() });
      } else {
        throw new GraphQLSyntaxError(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const definitions: VariableDefinition[] = [];
    if (this.peek() !== '(') return definitions;
    this.next();
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek() === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      definitions.push({ name, defaultValue });
    }
    this.expect(')');
    return definitions;
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (this.isName(this.peek())) {
          selections.push({ kind: 'spread', name: this.next() });
        } else {
          selections.push({ kind: 'inline', selectionSet: this.parseSelectionSet() });
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek() === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias, arguments: args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token) || /^-?\d+[eE][+-]?\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArguments(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// -------------------------------------------------------------------------------------------
// schema (for introspection and field validation)
// -------------------------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'comments'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'description'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface GraphQLNode {
  type: string;
  data: unknown;
}

function node(type: string, data: unknown): GraphQLNode {
  return { type, data };
}

function isNode(value: unknown): value is GraphQLNode {
  return value !== null && typeof value === 'object' && 'type' in (value as Record<string, unknown>) && 'data' in (value as Record<string, unknown>);
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: ExecContext, data: unknown, args: Record<string, unknown>) => unknown;

function userByLogin(login: string): ScenarioUser {
  return SCENARIO_USERS.find((user) => user.login === login)
    ?? { id: 0, login, name: login, email: `${login}@example.invalid` };
}

function userNode(user: ScenarioUser | undefined): GraphQLNode | null {
  return user ? node('User', user) : null;
}

function issueNode(repo: Repo, issue: Issue): GraphQLNode {
  return node('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: PullRequest): GraphQLNode {
  return node('PullRequest', { repo, pull });
}

function repoNode(repo: Repo): GraphQLNode {
  return node('Repository', repo);
}

function commentNode(repo: Repo, issue: Issue, comment: IssueComment): GraphQLNode {
  return node('IssueComment', { repo, issue, comment });
}

interface IssueList {
  repo: Repo;
  issues: Issue[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

interface PullList {
  repo: Repo;
  pulls: PullRequest[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

interface FileList {
  repo: Repo;
  pull: PullRequest;
  files: Array<{ path: string; additions: number; deletions: number; changeType: string }>;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

function pageInfoFor(total: number, start: number, count: number): { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } {
  return {
    hasNextPage: start + count < total,
    hasPreviousPage: start > 0,
    startCursor: count > 0 ? cursorOf(start) : null,
    endCursor: count > 0 ? cursorOf(start + count - 1) : null,
  };
}

function afterStart(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  const index = indexOfCursor(after);
  return index === null ? 0 : index + 1;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function resolveRepoById(forge: Forge, id: unknown): Repo | undefined {
  if (typeof id === 'number') return forge.repoById(id);
  if (typeof id === 'string') {
    const numeric = Number.parseInt(id, 10);
    if (String(numeric) === id) return forge.repoById(numeric);
    const parsed = parseGlobalId(id);
    if (parsed && parsed[0] === 'Repository') return forge.repoById(Number.parseInt(parsed[1], 10));
  }
  return undefined;
}

function resolveIssueById(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed[0] !== 'Issue') return undefined;
  const [repoId, number] = parsed[1].split(':');
  const repo = forge.repoById(Number.parseInt(repoId as string, 10));
  if (!repo) return undefined;
  const issue = repo.issues.get(Number.parseInt(number as string, 10));
  if (!issue) return undefined;
  return { repo, issue };
}

function resolvePullById(forge: Forge, id: unknown): { repo: Repo; pull: PullRequest } | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed[0] !== 'PullRequest') return undefined;
  const [repoId, number] = parsed[1].split(':');
  const repo = forge.repoById(Number.parseInt(repoId as string, 10));
  if (!repo) return undefined;
  const pull = repo.pulls.get(Number.parseInt(number as string, 10));
  if (!pull) return undefined;
  return { repo, pull };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => userNode(ctx.forge.viewer),
    repository: (ctx, _data, args) => {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (!owner || !name) return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo ? repoNode(repo) : null;
    },
    node: (ctx, _data, args) => {
      const id = asString(args.id);
      if (!id) return null;
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      const [type, key] = parsed;
      if (type === 'Repository') {
        const repo = ctx.forge.repoById(Number.parseInt(key, 10));
        return repo ? repoNode(repo) : null;
      }
      if (type === 'Issue') {
        const found = resolveIssueById(ctx.forge, id);
        return found ? issueNode(found.repo, found.issue) : null;
      }
      if (type === 'PullRequest') {
        const found = resolvePullById(ctx.forge, id);
        return found ? pullNode(found.repo, found.pull) : null;
      }
      if (type === 'User') {
        const user = SCENARIO_USERS.find((candidate) => candidate.id === Number.parseInt(key, 10));
        return userNode(user);
      }
      return null;
    },
    __type: (_ctx, _data, args) => {
      const name = asString(args.name);
      if (!name || !SCHEMA[name]) return null;
      return node('__Type', { name, ...SCHEMA[name] });
    },
    __schema: () => node('__Schema', {}),
  },
  Mutation: {
    createIssue: (ctx, _data, args) => {
      const input = asRecord(args.input);
      const repo = resolveRepoById(ctx.forge, input.repositoryId);
      const title = asString(input.title);
      if (!repo || !title) throw new Error('createIssue requires a repository and a title');
      const issue = ctx.forge.createIssue(repo, title, asString(input.body) ?? '', []);
      return node('CreateIssuePayload', { issue: issueNode(repo, issue), clientMutationId: asString(input.clientMutationId) ?? null });
    },
    closeIssue: (ctx, _data, args) => {
      const input = asRecord(args.input);
      const found = resolveIssueById(ctx.forge, input.issueId);
      if (!found) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      found.issue.closedAt = ctx.forge.clock.nowIso();
      found.issue.updatedAt = ctx.forge.clock.nowIso();
      return node('CloseIssuePayload', { issue: issueNode(found.repo, found.issue), clientMutationId: asString(input.clientMutationId) ?? null });
    },
    createPullRequest: (ctx, _data, args) => {
      const input = asRecord(args.input);
      const repo = resolveRepoById(ctx.forge, input.repositoryId);
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      const title = asString(input.title);
      if (!repo || !head || !base || !title) throw new Error('createPullRequest requires a repository, head, base and title');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error('createPullRequest: head or base branch does not exist');
      const pull = ctx.forge.createPull(repo, title, asString(input.body) ?? '', head, base, headSha, baseSha);
      return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull), clientMutationId: asString(input.clientMutationId) ?? null });
    },
    mergePullRequest: (ctx, _data, args) => {
      const input = asRecord(args.input);
      const found = resolvePullById(ctx.forge, input.pullRequestId);
      if (!found) throw new Error('mergePullRequest: pull request not found');
      if (found.pull.state !== 'open') throw new Error('mergePullRequest: pull request is not open');
      if (ctx.forge.mergeableOf(found.repo, found.pull) === 'CONFLICTING') throw new Error('mergePullRequest: pull request has conflicts');
      const merged = ctx.forge.squashMerge(found.repo, found.pull);
      if ('conflict' in merged) throw new Error('mergePullRequest: pull request has conflicts');
      return node('MergePullRequestPayload', { pullRequest: pullNode(found.repo, found.pull), clientMutationId: asString(input.clientMutationId) ?? null });
    },
    addComment: (ctx, _data, args) => {
      const input = asRecord(args.input);
      const found = resolveIssueById(ctx.forge, input.subjectId);
      const body = asString(input.body);
      if (!found || !body) throw new Error('addComment requires an issue and a body');
      const now = ctx.forge.clock.nowIso();
      const comment: IssueComment = { id: ctx.forge.nextCommentId, body, createdAt: now, updatedAt: now };
      ctx.forge.nextCommentId += 1;
      found.issue.comments.push(comment);
      return node('AddCommentPayload', {
        commentEdge: node('IssueCommentEdge', { node: commentNode(found.repo, found.issue, comment), cursor: cursorOf(0) }),
        clientMutationId: asString(input.clientMutationId) ?? null,
      });
    },
  },
  User: {
    id: (_ctx, data) => globalId('User', String((data as ScenarioUser).id)),
    login: (_ctx, data) => (data as ScenarioUser).login,
    name: (_ctx, data) => (data as ScenarioUser).name,
    email: (_ctx, data) => (data as ScenarioUser).email,
    avatarUrl: (_ctx, data) => `https://avatars.githubusercontent.invalid/u/${(data as ScenarioUser).id}?v=4`,
    url: (_ctx, data) => `https://github.invalid/${(data as ScenarioUser).login}`,
  },
  Repository: {
    id: (_ctx, data) => globalId('Repository', String((data as Repo).id)),
    databaseId: (_ctx, data) => (data as Repo).id,
    name: (_ctx, data) => (data as Repo).name,
    nameWithOwner: (_ctx, data) => `${(data as Repo).owner}/${(data as Repo).name}`,
    owner: (_ctx, data) => userNode(userByLogin((data as Repo).owner)),
    defaultBranchRef: (_ctx, data) => {
      const repo = data as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return node('Ref', { name: repo.defaultBranch, target: tip, repo });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, data) => (data as Repo).description,
    createdAt: (_ctx, data) => (data as Repo).createdAt,
    updatedAt: (_ctx, data) => (data as Repo).updatedAt,
    url: (_ctx, data) => `https://github.invalid/${(data as Repo).owner}/${(data as Repo).name}`,
    issue: (_ctx, data, args) => {
      const repo = data as Repo;
      const number = asInt(args.number);
      if (number === undefined) return null;
      const issue = repo.issues.get(number);
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (_ctx, data, args) => {
      const repo = data as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = asRecord(args.orderBy);
      const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
      const compare = (a: Issue, b: Issue): number => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.number - b.number;
      };
      issues.sort((a, b) => (direction === 'DESC' ? -compare(a, b) : compare(a, b)));
      const first = asInt(args.first);
      const start = afterStart(args.after);
      const sliced = first !== undefined ? issues.slice(start, start + first) : issues.slice(start);
      return node('IssueConnection', {
        repo,
        issues: sliced,
        pageInfo: pageInfoFor(issues.length, start, sliced.length),
      } satisfies IssueList);
    },
    pullRequest: (_ctx, data, args) => {
      const repo = data as Repo;
      const number = asInt(args.number);
      if (number === undefined) return null;
      const pull = repo.pulls.get(number);
      return pull ? pullNode(repo, pull) : null;
    },
    pullRequests: (_ctx, data, args) => {
      const repo = data as Repo;
      let pulls = [...repo.pulls.values()];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => {
          if (wanted.has('OPEN')) return pull.state === 'open';
          if (wanted.has('CLOSED')) return pull.state === 'closed';
          if (wanted.has('MERGED')) return pull.state === 'closed' && pull.merged;
          return false;
        });
      }
      pulls.sort((a, b) => a.number - b.number);
      const first = asInt(args.first);
      const start = afterStart(args.after);
      const sliced = first !== undefined ? pulls.slice(start, start + first) : pulls.slice(start);
      return node('PullRequestConnection', {
        repo,
        pulls: sliced,
        pageInfo: pageInfoFor(pulls.length, start, sliced.length),
      } satisfies PullList);
    },
  },
  Issue: {
    id: (_ctx, data) => globalId('Issue', `${(data as { repo: Repo; issue: Issue }).repo.id}:${(data as { repo: Repo; issue: Issue }).issue.number}`),
    number: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.number,
    title: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.title,
    body: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.body,
    state: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.state.toUpperCase(),
    author: (ctx, data) => userNode(ctx.forge.viewer),
    createdAt: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.createdAt,
    updatedAt: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.updatedAt,
    closedAt: (_ctx, data) => (data as { repo: Repo; issue: Issue }).issue.closedAt,
    url: (_ctx, data) => {
      const { repo, issue } = data as { repo: Repo; issue: Issue };
      return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    comments: (_ctx, data, args) => {
      const { repo, issue } = data as { repo: Repo; issue: Issue };
      const first = asInt(args.first);
      const sliced = first !== undefined ? issue.comments.slice(0, first) : issue.comments;
      return node('IssueConnection', {
        repo,
        issues: [],
        pageInfo: pageInfoFor(issue.comments.length, 0, sliced.length),
        comments: sliced,
      } as unknown as IssueList);
    },
  },
  PullRequest: {
    id: (_ctx, data) => globalId('PullRequest', `${(data as { repo: Repo; pull: PullRequest }).repo.id}:${(data as { repo: Repo; pull: PullRequest }).pull.number}`),
    number: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.number,
    title: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.title,
    body: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.body,
    state: (_ctx, data) => {
      const pull = (data as { repo: Repo; pull: PullRequest }).pull;
      if (pull.state === 'closed') return pull.merged ? 'MERGED' : 'CLOSED';
      return 'OPEN';
    },
    headRefName: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.headRef,
    baseRefName: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.baseRef,
    mergeable: (ctx, data) => {
      const { repo, pull } = data as { repo: Repo; pull: PullRequest };
      return ctx.forge.mergeableOf(repo, pull);
    },
    merged: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.merged,
    author: (ctx, _data) => userNode(ctx.forge.viewer),
    createdAt: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.createdAt,
    updatedAt: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.updatedAt,
    closedAt: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.closedAt,
    mergedAt: (_ctx, data) => (data as { repo: Repo; pull: PullRequest }).pull.mergedAt,
    files: (ctx, data, args) => {
      const { repo, pull } = data as { repo: Repo; pull: PullRequest };
      const baseTree = ctx.forge.treeOfCommit(repo, pull.baseSha);
      const headTree = ctx.forge.treeOfCommit(repo, pull.headSha);
      const diff = ctx.forge.diffTrees(repo, baseTree, headTree);
      const files = diff.map((change) => ({
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      const first = asInt(args.first);
      const start = afterStart(args.after);
      const sliced = first !== undefined ? files.slice(start, start + first) : files.slice(start);
      return node('PullRequestChangedFileConnection', {
        repo,
        pull,
        files: sliced,
        pageInfo: pageInfoFor(files.length, start, sliced.length),
      } satisfies FileList);
    },
  },
  IssueComment: {
    id: (_ctx, data) => {
      const { repo, issue, comment } = data as { repo: Repo; issue: Issue; comment: IssueComment };
      return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
    },
    body: (_ctx, data) => (data as { repo: Repo; issue: Issue; comment: IssueComment }).comment.body,
    author: (ctx, _data) => userNode(ctx.forge.viewer),
    createdAt: (_ctx, data) => (data as { repo: Repo; issue: Issue; comment: IssueComment }).comment.createdAt,
    updatedAt: (_ctx, data) => (data as { repo: Repo; issue: Issue; comment: IssueComment }).comment.updatedAt,
    url: (_ctx, data) => {
      const { repo, issue, comment } = data as { repo: Repo; issue: Issue; comment: IssueComment };
      return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
    },
  },
  Ref: {
    id: (_ctx, data) => globalId('Ref', `${(data as { repo: Repo; name: string }).repo.id}:${(data as { repo: Repo; name: string }).name}`),
    name: (_ctx, data) => (data as { repo: Repo; name: string }).name,
    target: (_ctx, data) => node('Commit', { oid: (data as { target: string }).target }),
  },
  Commit: {
    id: (_ctx, data) => globalId('Commit', (data as { oid: string }).oid),
    oid: (_ctx, data) => (data as { oid: string }).oid,
    message: () => '',
  },
  IssueConnection: {
    nodes: (_ctx, data) => (data as IssueList).issues.map((issue) => issueNode((data as IssueList).repo, issue)),
    edges: (_ctx, data) => (data as IssueList).issues.map((issue, index) => node('IssueEdge', { node: issueNode((data as IssueList).repo, issue), cursor: cursorOf(index) })),
    totalCount: (_ctx, data) => (data as IssueList).issues.length,
    pageInfo: (_ctx, data) => node('PageInfo', (data as IssueList).pageInfo),
  },
  PullRequestConnection: {
    nodes: (_ctx, data) => (data as PullList).pulls.map((pull) => pullNode((data as PullList).repo, pull)),
    edges: (_ctx, data) => (data as PullList).pulls.map((pull, index) => node('PullRequestEdge', { node: pullNode((data as PullList).repo, pull), cursor: cursorOf(index) })),
    totalCount: (_ctx, data) => (data as PullList).pulls.length,
    pageInfo: (_ctx, data) => node('PageInfo', (data as PullList).pageInfo),
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, data) => (data as FileList).files.map((file) => node('PullRequestChangedFile', file)),
    edges: (_ctx, data) => (data as FileList).files.map((file, index) => node('PullRequestChangedFileEdge', { node: node('PullRequestChangedFile', file), cursor: cursorOf(index) })),
    totalCount: (_ctx, data) => (data as FileList).files.length,
    pageInfo: (_ctx, data) => node('PageInfo', (data as FileList).pageInfo),
  },
  IssueEdge: {
    node: (_ctx, data) => (data as { node: GraphQLNode }).node,
    cursor: (_ctx, data) => (data as { cursor: string }).cursor,
  },
  PullRequestEdge: {
    node: (_ctx, data) => (data as { node: GraphQLNode }).node,
    cursor: (_ctx, data) => (data as { cursor: string }).cursor,
  },
  PullRequestChangedFileEdge: {
    node: (_ctx, data) => (data as { node: GraphQLNode }).node,
    cursor: (_ctx, data) => (data as { cursor: string }).cursor,
  },
  PullRequestChangedFile: {
    path: (_ctx, data) => (data as { path: string }).path,
    additions: (_ctx, data) => (data as { additions: number }).additions,
    deletions: (_ctx, data) => (data as { deletions: number }).deletions,
    changeType: (_ctx, data) => (data as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (_ctx, data) => (data as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (_ctx, data) => (data as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (_ctx, data) => (data as { startCursor: string | null }).startCursor,
    endCursor: (_ctx, data) => (data as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (_ctx, data) => (data as { issue: GraphQLNode }).issue,
    clientMutationId: (_ctx, data) => (data as { clientMutationId: string | null }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (_ctx, data) => (data as { issue: GraphQLNode }).issue,
    clientMutationId: (_ctx, data) => (data as { clientMutationId: string | null }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, data) => (data as { pullRequest: GraphQLNode }).pullRequest,
    clientMutationId: (_ctx, data) => (data as { clientMutationId: string | null }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, data) => (data as { pullRequest: GraphQLNode }).pullRequest,
    clientMutationId: (_ctx, data) => (data as { clientMutationId: string | null }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, data) => (data as { commentEdge: GraphQLNode }).commentEdge,
    clientMutationId: (_ctx, data) => (data as { clientMutationId: string | null }).clientMutationId,
  },
  IssueCommentEdge: {
    node: (_ctx, data) => (data as { node: GraphQLNode }).node,
    cursor: (_ctx, data) => (data as { cursor: string }).cursor,
  },
  __Type: {
    name: (_ctx, data) => (data as { name: string }).name,
    kind: (_ctx, data) => (data as { kind: string }).kind,
    description: () => null,
    fields: (_ctx, data) => {
      const info = data as TypeInfo & { name: string };
      if (!info.fields) return null;
      return info.fields.map((name) => node('__Field', { name }));
    },
    enumValues: (_ctx, data) => {
      const info = data as TypeInfo & { name: string };
      if (!info.enumValues) return null;
      return info.enumValues.map((name) => node('__EnumValue', { name }));
    },
  },
  __Field: {
    name: (_ctx, data) => (data as { name: string }).name,
    description: () => null,
  },
  __EnumValue: {
    name: (_ctx, data) => (data as { name: string }).name,
    description: () => null,
  },
  __Schema: {
    types: () => Object.entries(SCHEMA).map(([name, info]) => node('__Type', { name, ...info })),
    queryType: () => node('__Type', { name: 'Query', ...SCHEMA.Query }),
    mutationType: () => node('__Type', { name: 'Mutation', ...SCHEMA.Mutation }),
    description: () => null,
  },
};

function executeSelection(ctx: ExecContext, typeName: string, data: unknown, selections: SelectionNode[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const responseName = selection.alias ?? selection.name;
      const fields = RESOLVERS[typeName];
      const resolver = fields?.[selection.name];
      if (!resolver) {
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
        result[responseName] = null;
        continue;
      }
      const args = resolveArguments(selection.arguments, ctx.variables);
      let value: unknown;
      try {
        value = resolver(ctx, data, args);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        result[responseName] = null;
        continue;
      }
      result[responseName] = completeValue(ctx, value, selection.selectionSet);
    } else if (selection.kind === 'inline') {
      if (!selection.typeCondition || selection.typeCondition === typeName) {
        Object.assign(result, executeSelection(ctx, typeName, data, selection.selectionSet));
      }
    } else if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (!fragment.typeCondition || fragment.typeCondition === typeName)) {
        Object.assign(result, executeSelection(ctx, typeName, data, fragment.selectionSet));
      }
    }
  }
  return result;
}

function completeValue(ctx: ExecContext, value: unknown, selectionSet?: SelectionNode[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selectionSet));
  if (isNode(value)) {
    if (!selectionSet) return value.data;
    return executeSelection(ctx, value.type, value.data, selectionSet);
  }
  return value;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(forge: Forge, document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): GraphQLResult {
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  // Apply variable defaults.
  for (const definition of operation.variableDefinitions) {
    if (!(definition.name in ctx.variables) && definition.defaultValue) {
      ctx.variables[definition.name] = resolveValue(definition.defaultValue, variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selectionSet);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function executeGraphQL(forge: Forge, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeSingle(forge, entry));
  }
  return executeSingle(forge, body);
}

function executeSingle(forge: Forge, body: unknown): GraphQLResult {
  const record = asRecord(body);
  const query = asString(record.query);
  if (!query) return { data: null, errors: [{ message: 'A query document is required.' }] };
  const variables = asRecord(record.variables);
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  const operationName = asString(record.operationName);
  const operation = operationName
    ? document.operations.find((op) => op.name === operationName)
    : document.operations[0];
  if (!operation) return { data: null, errors: [{ message: `Unknown operation ${operationName ?? ''}.` }] };
  try {
    return executeOperation(forge, document, operation, { ...variables });
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
