# github-core-clone-01-entry-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/saifulsidik801-ship-it/github-core-clone-entry-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/saifulsidik801-ship-it/github-core-clone-entry-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one statically-linked Go binary (standard library only, no dependencies): git smart HTTP (protocol v2 and v0, shallow/thin-pack, fast-forward enforcement), REST v3 (repos, branches, commits, contents, labels, issues, pulls), GraphQL v4 (viewer, repository, connections with cursors, mutations, introspection) and MCP (era 2026-07-28, 8 tools). Deterministic seeded timestamps, in-memory store, response caches on the hot paths. `main.ts` is a thin launcher that spawns the `forge` binary next to it.

## Run it

```sh
node --experimental-strip-types main.ts
```

## Build it

```sh
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o forge .
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=59gqp20q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
