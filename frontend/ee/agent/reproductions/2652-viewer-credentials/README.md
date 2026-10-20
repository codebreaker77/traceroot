# Viewer credentials and reused sandboxes: issue #2652

Supporting reproduction for [issue #2652](https://github.com/traceroot-ai/traceroot/issues/2652), based on upstream commit `b6c6b1055904c8ae789e358e830b7d3308fab078`.

This branch shares the isolated tests behind the role-downgrade finding. It contains no implementation fix and is intended to help coordinate regression coverage with the issue's implementation author. These tests assert the vulnerable **current behavior**, so passing does not mean the security issue is fixed. They will need to be adapted to assert the agreed safe behavior when the implementation is ready.

## Run

Use the repository's Node.js/pnpm prerequisites and install the frontend workspace dependencies:

```sh
pnpm --dir frontend install --frozen-lockfile
cd frontend/ee/agent
node node_modules/vitest/vitest.mjs run --config reproductions/2652-viewer-credentials/vitest.config.ts
```

The dedicated config keeps this reproduction separate from the normal test suite. It writes an ignored `results.json` alongside the tests. No environment file, actual GitHub credentials, Docker daemon, or Daytona account is needed.

## Cases

Nine cases exercise the actual UI message/token handlers, authorization helpers, demo guard, internal-secret verifier, sandbox registry, clone credential setup, and bash tool:

- Fresh ordinary-workspace VIEWER: the proxy accepts a message and a separately invoked clone tool reaches credential setup.
- MEMBER and ADMIN downgraded to VIEWER after an authenticated clone: the proxy accepts the same user's next message; the registry reuses the executor; a separately invoked bash tool forwards a simulated write command without another clone or token mint.
- Browser token request as VIEWER is refused, while the internal-secret path returns a fixture token.
- Removed membership and demo-workspace VIEWER messages are refused without forwarding.
- Explicit registry release produces a new executor without the modeled credential (a control within the downgrade cases).

Fresh-viewer and downgrade cases each use the Docker and Daytona executors' production `hasNativeGit` predicates on fake executors. Both return true and select the same native-git credential setup path. These variants are not separate provider integrations.

## Mock boundaries

Prisma data, the authenticated browser session, support-impersonation wrapper, installation-token mint, upstream SSE response, and sandbox commands/files/cloning are mocked. A small native Request/Response shim replaces Next's request/response wrappers. The fake executor models stored gh authentication; it never executes a shell or gh client. Unknown fetch destinations throw.

This is a composition of isolated handlers and tools, **not an end-to-end service test**. The mocked SSE response does not invoke the agent; the harness explicitly acquires the registry entry and invokes tools afterward. It does not run the Hono message handler, provider inference, PostgreSQL, Docker, Daytona, GitHub permission enforcement, a real GitHub write, or active-turn cancellation. No cross-user session access is claimed: the conversation owner remains the same user throughout.

## Regression coverage to coordinate

Once maintainers confirm how a role reduction should affect an existing sandbox, adapt the reproduction into native regression tests for:

1. Restricted fresh-viewer credentials, while preserving intended MEMBER/ADMIN behavior.
2. An authenticated clone followed by a MEMBER/ADMIN-to-VIEWER downgrade and a next bash call without another clone.
3. An active turn using the old sandbox when the role is reduced.
4. Continued denial for removed members and demo viewers.

The active-turn case is a proposed next test, not coverage supplied by this branch. Sandbox replacement can discard local changes and needs an agreed policy. Clearing cached credentials also does not establish revocation of a token copied outside the sandbox.
