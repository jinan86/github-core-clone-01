// GitHub REST v3 surface, implemented to the kit's checks-rest.ts expectations:
// bearer auth is enforced by app.ts; every reply is JSON with a non-empty
// X-GitHub-Request-Id; lists paginate with Link headers whose URLs point at this
// server (the suite follows them as absolute URLs).

import { displayMessage, globalId } from './util.ts';
import { SCENARIO_USERS } from './scenario.ts';
import {
  hashObject,
  parseCommit,
  type Forge,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
  type ScenarioUser,
} from './store.ts';

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

let requestCounter = 0;

export function requestIdHeader(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16)}-${process.pid}`;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, headers, body };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  try {
    const cleaned = value.replace(/\s+/g, '');
    if (cleaned.length % 4 !== 0) return null;
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

/** Look a login up in the scenario's users; unknown logins get a synthetic user. */
function userByLogin(login: string): ScenarioUser {
  return SCENARIO_USERS.find((user) => user.login === login)
    ?? { id: 0, login, name: login, email: `${login}@example.invalid` };
}

function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('User', String(user.id)),
    avatar_url: `https://avatars.githubusercontent.invalid/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.invalid/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(userByLogin(repo.owner)),
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, label: { id: number; name: string; color: string }): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', `${repo.id}:${label.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: label.name === 'bug' || label.name === 'documentation' || label.name === 'duplicate'
      || label.name === 'enhancement' || label.name === 'good first issue' || label.name === 'help wanted'
      || label.name === 'invalid' || label.name === 'question' || label.name === 'wontfix',
    description: '',
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(forge.viewer),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(repo, label) : { id: 0, node_id: '', url: '', name, color: 'ededed', default: false, description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeable = forge.mergeableOf(repo, pull);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(forge.viewer),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : 'dirty',
    merged: pull.merged,
    merge_method: 'squash',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip,
      user: userJson(forge.viewer),
      repo: repoJson(forge, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip,
      user: userJson(forge.viewer),
      repo: repoJson(forge, repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
  };
}

function commentJson(forge: Forge, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issueNumber}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(forge.viewer),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

/** Parse a raw git ident line ("Name <email> 1234567890 +0000") into its parts. */
function parseIdent(raw: string): { name: string; email: string; date: string } {
  const match = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw.trim());
  if (!match) return { name: raw, email: '', date: '' };
  const ts = Number.parseInt(match[3] as string, 10);
  return { name: match[1] as string, email: match[2] as string, date: new Date(ts * 1000).toISOString() };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const viewer = forge.viewer;
  return {
    sha,
    node_id: globalId('Commit', `${repo.id}:${sha}`),
    commit: {
      author,
      committer,
      message: displayMessage(commit.message),
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: author.email === viewer.email ? userJson(viewer) : null,
    committer: committer.email === viewer.email ? userJson(viewer) : null,
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `https://github.invalid/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, host: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const base = `http://${host}${path}`;
  const links: string[] = [];
  if (pageNum < totalPages) {
    links.push(`<${base}?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`);
    links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (pageNum > 1) {
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${base}?per_page=${perPage}&page=${pageNum - 1}>; rel="prev"`);
  }
  if (links.length) headers.link = links.join(', ');
  return { page, headers };
}

interface RouteContext {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  host: string;
  body: unknown;
}

/** Parse a JSON body; returns `{ ok: false }` on malformed JSON. */
export function parseJsonBody(text: string): { ok: boolean; value: unknown } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return (value !== null && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
}

function repoOr404(ctx: RouteContext, owner: string, name: string): Repo | RestResponse {
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

export async function handleRest(ctx: RouteContext): Promise<RestResponse> {
  const { forge, method } = ctx;
  const s = ctx.segments;
  const query = ctx.query;

  // GET /api/v3/ (root) and /api/v3/meta
  if (s.length === 0) {
    if (method === 'GET') {
      return ok({
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.invalid/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      });
    }
    return err(404, 'Not Found');
  }
  if (s.length === 1 && s[0] === 'meta') {
    if (method === 'GET') return ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
    return err(404, 'Not Found');
  }
  if (s.length === 1 && s[0] === 'user') {
    if (method === 'GET') {
      const viewer = forge.viewer;
      return ok({
        ...userJson(viewer),
        html_url: `https://github.invalid/${viewer.login}`,
        followers_url: `/api/v3/users/${viewer.login}/followers`,
        following_url: `/api/v3/users/${viewer.login}/following{/other_user}`,
        gists_url: `/api/v3/users/${viewer.login}/gists{/gist_id}`,
        starred_url: `/api/v3/users/${viewer.login}/starred{/owner}{/repo}`,
        subscriptions_url: `/api/v3/users/${viewer.login}/subscriptions`,
        organizations_url: `/api/v3/users/${viewer.login}/orgs`,
        repos_url: `/api/v3/users/${viewer.login}/repos`,
        events_url: `/api/v3/users/${viewer.login}/events{/privacy}`,
        received_events_url: `/api/v3/users/${viewer.login}/received_events`,
        followers: 0,
        following: 0,
        public_repos: forge.listViewerRepos().length,
        public_gists: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: forge.clock.nowIso(),
      });
    }
    return err(404, 'Not Found');
  }
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listViewerRepos().map((repo) => repoJson(forge, repo));
      const { page, headers } = paginate(repos, query, '/api/v3/user/repos', ctx.host);
      return ok(page, 200, headers);
    }
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is invalid');
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = forge.createRepo(forge.viewer.login, name, { description, isPrivate });
      if (!repo) return err(422, 'Repository already exists on this account');
      return ok(repoJson(forge, repo), 201);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeURIComponent(s[1] as string);
    const name = decodeURIComponent(s[2] as string);
    const rest = s.slice(3);
    const repo = repoOr404(ctx, owner, name);
    if ('status' in repo) return repo;

    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(forge, repo));
      if (method === 'PATCH') {
        const body = asObject(ctx.body);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
          (repo as { defaultBranch: string }).defaultBranch = body.default_branch;
        }
        if (typeof body.name === 'string' && body.name.trim() !== '' && body.name !== repo.name) {
          const newName = (body.name as string).trim();
          if (forge.getRepo(owner, newName)) return err(422, 'Repository already exists on this account');
          forge.repos.delete(`${owner}/${repo.name}`);
          (repo as { name: string }).name = newName;
          forge.repos.set(`${owner}/${newName}`, repo);
        }
        repo.updatedAt = forge.clock.nowIso();
        return ok(repoJson(forge, repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = forge.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `/api/v3/repos/${owner}/${name}/commits/${branch.sha}` },
          protected: false,
        }));
        const { page, headers } = paginate(branches, query, `/api/v3/repos/${owner}/${name}/branches`, ctx.host);
        return ok(page, 200, headers);
      }
      if (rest.length === 2 && method === 'GET') {
        const branchName = decodeURIComponent(rest[1] as string);
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (tip === undefined) return err(404, 'Branch not found');
        return ok({
          name: branchName,
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
          protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
          protection_url: `/api/v3/repos/${owner}/${name}/branches/${encodeURIComponent(branchName)}/protection`,
        });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 3) {
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const branchName = decodeURIComponent(rest[3] as string);
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (tip === undefined) return err(404, 'Not Found');
        return ok({
          ref: `refs/heads/${branchName}`,
          node_id: globalId('Ref', `${repo.id}:refs/heads/${branchName}`),
          url: `/api/v3/repos/${owner}/${name}/git/refs/heads/${branchName}`,
          object: { sha: tip, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${tip}` },
        });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      const body = asObject(ctx.body);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
      const object = repo.objects.get(sha);
      if (!object || (object.type !== 'commit' && object.type !== 'tag')) return err(422, 'Object does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.updatedAt = forge.clock.nowIso();
      return ok({
        ref,
        node_id: globalId('Ref', `${repo.id}:${ref}`),
        url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}`,
        object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` },
      }, 201);
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const refParam = query.get('sha');
      const tip = refParam ? forge.resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const history = tip ? forge.commitHistory(repo, tip) : [];
      const commits = history.map((sha) => commitJson(forge, repo, sha)).filter((item): item is Record<string, unknown> => item !== null);
      const { page, headers } = paginate(commits, query, `/api/v3/repos/${owner}/${name}/commits`, ctx.host);
      return ok(page, 200, headers);
    }

    if (rest[0] === 'contents') {
      return handleContents(ctx, repo, rest.slice(1), owner, name);
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        return ok([...repo.labels.values()].map((label) => labelJson(repo, label)));
      }
      if (rest.length === 1 && method === 'POST') {
        const body = asObject(ctx.body);
        const labelName = typeof body.name === 'string' ? body.name.trim() : '';
        if (labelName === '') return err(422, 'name is required');
        if (repo.labels.has(labelName)) return err(422, 'Label already exists');
        const label = { id: forge.nextLabelId, name: labelName, color: typeof body.color === 'string' ? body.color : 'ededed' };
        forge.nextLabelId += 1;
        repo.labels.set(labelName, label);
        return ok(labelJson(repo, label), 201);
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      return handleIssues(ctx, repo, rest.slice(1), owner, name);
    }

    if (rest[0] === 'pulls') {
      return handlePulls(ctx, repo, rest.slice(1), owner, name);
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function resolveContentsRef(forge: Forge, repo: Repo, query: URLSearchParams): string | undefined {
  const ref = query.get('ref');
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return forge.resolveRef(repo, ref) ?? undefined;
}

function handleContents(ctx: RouteContext, repo: Repo, rest: string[], owner: string, name: string): RestResponse {
  const { forge, method, query } = ctx;
  const path = rest.map((segment) => decodeURIComponent(segment)).join('/');
  const refTip = resolveContentsRef(forge, repo, query);

  if (method === 'GET') {
    if (!refTip) return err(404, 'Not Found');
    const treeOid = forge.treeOfCommit(repo, refTip) ?? forge.emptyTreeOid(repo);
    const flat = forge.flattenTree(repo, treeOid);
    const prefix = path === '' ? '' : `${path}/`;
    // Exact file?
    if (path !== '' && flat.has(path)) {
      const entry = flat.get(path) as { oid: string; mode: string };
      const blob = repo.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return err(404, 'Not Found');
      return ok({
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() as string,
        path,
        content: blob.data.toString('base64'),
        sha: entry.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,
        git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`,
        html_url: `https://github.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${path}`,
        download_url: null,
        _links: { git: `/api/v3/repos/${owner}/${name}/git/blobs/${entry.oid}`, self: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, html: `https://github.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${path}` },
      });
    }
    // Directory listing: immediate children of the prefix.
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
    for (const [filePath, entry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const restPath = filePath.slice(prefix.length);
      const first = restPath.split('/')[0] as string;
      if (restPath.includes('/')) {
        children.set(first, { type: 'dir', name: first, path: `${prefix}${first}`, sha: '' });
      } else {
        const blob = repo.objects.get(entry.oid);
        children.set(first, { type: 'file', name: first, path: filePath, sha: entry.oid, size: blob?.data.length ?? 0 });
      }
    }
    if (path !== '' && children.size === 0) return err(404, 'Not Found');
    const listing = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((child) => ({
      ...child,
      url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(child.path)}`,
      git_url: child.type === 'file' ? `/api/v3/repos/${owner}/${name}/git/blobs/${child.sha}` : `/api/v3/repos/${owner}/${name}/git/trees/${child.sha}`,
      html_url: `https://github.invalid/${owner}/${name}/${child.type === 'file' ? 'blob' : 'tree'}/${repo.defaultBranch}/${child.path}`,
      download_url: null,
    }));
    return ok(listing);
  }

  if (method === 'PUT') {
    const body = asObject(ctx.body);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const content = decodeBase64(body.content);
    if (content === null) return err(422, 'content must be base64');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    let parents: string[] = [];
    if (tip === undefined) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        // Branch from the default tip when the branch does not exist yet.
        repo.refs.set(`refs/heads/${branch}`, defaultTip);
        tip = defaultTip;
        parents = [tip];
      }
      // Otherwise the repository is unborn: the initial commit has no parents.
    } else {
      parents = [tip];
    }
    const treeOid = forge.treeOfCommit(repo, tip) ?? forge.emptyTreeOid(repo);
    const flat = forge.flattenTree(repo, treeOid);
    const existing = flat.get(path);
    const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing) {
      if (expectedSha === undefined) return err(409, 'sha was not supplied');
      if (expectedSha !== existing.oid) return err(409, 'sha does not match');
    } else if (expectedSha !== undefined) {
      return err(422, 'sha was supplied for a file that does not exist');
    }
    const blobOid = hashObject('blob', content);
    const newTree = forge.applyFileToTree(repo, tip ?? null, path, content);
    const commitSha = forge.makeCommit(repo, newTree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = forge.clock.nowIso();
    return ok({
      content: {
        name: path.split('/').pop() as string,
        path,
        sha: blobOid,
        size: content.length,
        url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`,
        html_url: `https://github.invalid/${owner}/${name}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`,
        download_url: null,
        type: 'file',
        content: content.toString('base64'),
        encoding: 'base64',
        _links: { git: `/api/v3/repos/${owner}/${name}/git/blobs/${blobOid}`, self: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`, html: `https://github.invalid/${owner}/${name}/blob/${branch}/${path}` },
      },
      commit: commitJson(forge, repo, commitSha),
    }, existing ? 200 : 201);
  }

  if (method === 'DELETE') {
    const body = asObject(ctx.body);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return err(404, 'Not Found');
    const treeOid = forge.treeOfCommit(repo, tip) ?? forge.emptyTreeOid(repo);
    const flat = forge.flattenTree(repo, treeOid);
    const existing = flat.get(path);
    if (!existing) return err(404, 'Not Found');
    const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (expectedSha !== undefined && expectedSha !== existing.oid) return err(409, 'sha does not match');
    const newTree = forge.applyFileToTree(repo, tip, path, null);
    const commitSha = forge.makeCommit(repo, newTree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.updatedAt = forge.clock.nowIso();
    return ok({ commit: commitJson(forge, repo, commitSha) }, 200);
  }

  return err(404, 'Not Found');
}

function handleIssues(ctx: RouteContext, repo: Repo, rest: string[], owner: string, name: string): RestResponse {
  const { forge, method, query } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const compare = (a: Issue, b: Issue): number => {
        if (sort === 'created') {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.number - b.number;
        }
        return a.number - b.number;
      };
      issues.sort((a, b) => (direction === 'desc' ? -compare(a, b) : compare(a, b)));
      const { page, headers } = paginate(issues.map((issue) => issueJson(forge, repo, issue)), query, `/api/v3/repos/${owner}/${name}/issues`, ctx.host);
      return ok(page, 200, headers);
    }
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (title === '') return err(422, 'title is required');
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labelNames: string[] = [];
      for (const raw of rawLabels) {
        const labelName = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).name : undefined);
        if (typeof labelName !== 'string') continue;
        if (!repo.labels.has(labelName)) return err(422, `Label "${labelName}" does not exist`);
        labelNames.push(labelName);
      }
      const issue = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
      return ok(issueJson(forge, repo, issue), 201);
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') return ok(issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const body = asObject(ctx.body);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedAt = forge.clock.nowIso();
      } else if (body.state === 'open' && issue.state !== 'open') {
        issue.state = 'open';
        issue.closedAt = null;
      }
      if (Array.isArray(body.labels)) {
        const labelNames: string[] = [];
        for (const raw of body.labels as unknown[]) {
          const labelName = typeof raw === 'string' ? raw : (raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).name : undefined);
          if (typeof labelName !== 'string') continue;
          if (!repo.labels.has(labelName)) return err(422, `Label "${labelName}" does not exist`);
          labelNames.push(labelName);
        }
        issue.labels = labelNames;
      }
      issue.updatedAt = forge.clock.nowIso();
      return ok(issueJson(forge, repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') {
      const comments = issue.comments.map((comment) => commentJson(forge, repo, number, comment));
      const { page, headers } = paginate(comments, query, `/api/v3/repos/${owner}/${name}/issues/${number}/comments`, ctx.host);
      return ok(page, 200, headers);
    }
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (commentBody.trim() === '') return err(422, 'body is required');
      const now = forge.clock.nowIso();
      const comment: IssueComment = { id: forge.nextCommentId, body: commentBody, createdAt: now, updatedAt: now };
      forge.nextCommentId += 1;
      issue.comments.push(comment);
      return ok(commentJson(forge, repo, number, comment), 201);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function handlePulls(ctx: RouteContext, repo: Repo, rest: string[], owner: string, name: string): RestResponse {
  const { forge, method, query } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') {
        pulls = pulls.filter((pull) => state === 'closed' ? pull.state !== 'open' : pull.state === state);
      }
      const compare = (a: PullRequest, b: PullRequest): number => {
        if (sort === 'created') {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.number - b.number;
        }
        return a.number - b.number;
      };
      pulls.sort((a, b) => (direction === 'desc' ? -compare(a, b) : compare(a, b)));
      const { page, headers } = paginate(pulls.map((pull) => pullJson(forge, repo, pull)), query, `/api/v3/repos/${owner}/${name}/pulls`, ctx.host);
      return ok(page, 200, headers);
    }
    if (method === 'POST') {
      const body = asObject(ctx.body);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const head = typeof body.head === 'string' ? body.head.trim() : '';
      const base = typeof body.base === 'string' ? body.base.trim() : '';
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
      if (head === base) return err(422, 'head and base must differ');
      const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) return err(422, 'A pull request already exists for this head branch');
      const pull = forge.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
      return ok(pullJson(forge, repo, pull), 201);
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);

  if (rest.length === 1 && method === 'GET') {
    if (!pull) return err(404, 'Not Found');
    return ok(pullJson(forge, repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) return err(404, 'Not Found');
    const baseTree = forge.treeOfCommit(repo, pull.baseSha);
    const headTree = forge.treeOfCommit(repo, pull.headSha);
    const diff = forge.diffTrees(repo, baseTree, headTree);
    return ok(diff.map((change) => ({
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      blob_url: `https://github.invalid/${owner}/${name}/blob/${pull.headSha}/${change.path}`,
      raw_url: `https://github.invalid/${owner}/${name}/raw/${pull.headSha}/${change.path}`,
      contents_url: `/api/v3/repos/${owner}/${name}/contents/${encodeURIComponent(change.path)}?ref=${pull.headRef}`,
    })));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return err(404, 'Not Found');
    if (pull.state !== 'open') return err(405, 'Pull request is not open');
    if (forge.mergeableOf(repo, pull) === 'CONFLICTING') return err(405, 'Pull request has conflicts');
    const merged = forge.squashMerge(repo, pull);
    if ('conflict' in merged) return err(405, 'Pull request has conflicts');
    return ok({
      sha: merged.sha,
      merged: true,
      message: displayMessage(`${pull.title} (#${pull.number})`),
    }, 200);
  }

  return err(404, 'Not Found');
}
