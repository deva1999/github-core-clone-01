# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/deva1999/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/deva1999/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge. One process, one file
(`main.ts`), Node.js standard library only — no git binary, no package
manager, no outside service. It serves four surfaces from a single
in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch` with shallow/deepen support)
  plus a v0 fallback, and receive-pack v0 with `report-status`,
  `side-band-64k` and `delete-refs`. The git object model, pkt-line framing
  and packfile read/write (including OFS/REF delta resolution on receive)
  are implemented by hand; objects are stored byte-exact as pushed.
- **GitHub REST v3** under `/api/v3` — repositories (create/list/get/patch/
  delete with `Link` pagination), branches, commits, the contents API
  (create/update/delete files with real git blob ids and 409 on a stale
  sha), labels, issues and comments, and pull requests with file diffs and
  squash/merge merges (405 on a conflicted three-way merge).
- **GitHub GraphQL v4** at `/api/graphql` — a small parser/executor for the
  documents `gh` and `github-mcp-server` send: `viewer`, `repository`,
  `node`, connections with cursor pagination and `orderBy`, the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations, batched operation arrays, and the introspection
  (`__type`) surface those clients read.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: revision
  2026-07-28 (`server/discover`) and the legacy `initialize` handshake;
  tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `get_issue`, `create_pull_request`, `merge_pull_request`, `close_issue`,
  acting on the same store as REST.

Every API call is authorized with `Authorization: Bearer
$MAKEFUN_SHOP_TOKEN`; the token's login owns every repository, and the same
name under another owner is a 404.

## Run it

```sh
node main.ts
```

## Lifecycle

Started as `node main.ts` (Node 22). With `MAKEFUN_ENV_URL` set (the trial
environment), the forge binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done`
answers `{"done": true}`, and exits 0. Without it, it runs standalone on
`$PORT` (default 8399) for local development.

## Determinism

Responses never depend on the wall clock or on randomness: timestamps come
from a logical clock over a fixed epoch, ids from counters, and the
viewer's login is derived from the contest's published scenario seed with
the same generator the suite uses — so two runs of a trial leave identical
results.

## Layout

- `main.ts` — the whole forge (object model, protocols, REST, GraphQL, MCP,
  lifecycle).
- `package.json` — module metadata (`"type": "module"`).
- `.makefun/owner.json` — the make.fun claim file naming the entrant wallet.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gx4yrk51&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
