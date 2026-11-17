# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jinan86/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jinan86/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process with zero dependencies: git smart HTTP (protocol v0 and v2, upload-pack and receive-pack), REST v3, GraphQL, and MCP, all backed by one in-memory store with a deterministic logical clock. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<your token> PORT=8080 node main.ts
```

In the make.fun trial the grader starts it as `node main.ts` with `MAKEFUN_ENV_URL` set; the entry binds an ephemeral port, registers with the environment, and exits when the environment reports done. Without `MAKEFUN_ENV_URL` it serves standalone on `$PORT` (default 8080). Node 22 is required (`node --experimental-strip-types` is not needed — the entry runs its TypeScript directly under Node 22's type stripping).

## What it serves

- **Git smart HTTP** — `/{owner}/{repo}.git/info/refs`, `git-upload-pack` (v0 and v2: ls-refs, fetch with depth/shallow/deepen, sideband packfiles) and `git-receive-pack` (v0, delta packs, fast-forward enforcement, per-ref `non-fast-forward` refusals). Works with the real `git` CLI for clone, fetch, push, shallow clone and deepen.
- **REST v3** — repositories, branches, refs, commits, contents, labels, issues, comments, pull requests, squash merge, pagination (`Link` headers), and `X-GitHub-Request-Id` on every response.
- **GraphQL** — `repository`, `viewer`, `node`, issues/pull-requests connections with cursors and `states`/`orderBy` filters, mutations (create/close issue, create/merge pull request, add comment), introspection (`__type`, `SearchType`), and batched requests.
- **MCP** — JSON-RPC 2.0 Streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

State is deterministic: all timestamps come from a logical clock, so trial replays export byte-identical state.

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
