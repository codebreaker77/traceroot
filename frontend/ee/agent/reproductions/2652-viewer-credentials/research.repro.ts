import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

const fixture = vi.hoisted(() => ({
  role: "MEMBER" as string | null,
  userId: "research-user",
  workspaceId: "research-workspace",
  projectId: "research-project",
  token: "FAKE_RESEARCH_TOKEN_NOT_A_GITHUB_CREDENTIAL",
  forwarded: [] as Array<{ url: string; headers: Record<string, string> }>,
  mint: vi.fn(),
}));

vi.mock("@traceroot/core", async () => {
  const { hasMinRole } = await import("../../../../packages/core/src/types/index.ts");
  return {
    hasMinRole,
    Role: { VIEWER: "VIEWER", MEMBER: "MEMBER", ADMIN: "ADMIN" },
    ModelSource: { BYOK: "byok", SYSTEM: "system" },
    PlanType: { FREE: "free" },
    isBillingEnabled: () => false,
    prisma: {
      project: {
        findUnique: async () => ({
          id: fixture.projectId,
          workspaceId: fixture.workspaceId,
          name: "research",
        }),
      },
      workspaceMember: {
        findUnique: async () =>
          fixture.role
            ? { userId: fixture.userId, workspaceId: fixture.workspaceId, role: fixture.role }
            : null,
      },
      workspace: { findUnique: async () => ({ aiBlocked: false, billingPlan: "free" }) },
      gitHubInstallation: {
        findMany: async () => [{ installationId: "123", accountLogin: "research" }],
      },
    },
  };
});
vi.mock("@/env", () => ({
  env: {
    INTERNAL_API_SECRET: "fixture-internal-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "FAKE_NOT_A_PRIVATE_KEY",
  },
}));
vi.mock("@/lib/request-session", () => ({
  getRequestSession: async () => ({ user: { id: fixture.userId } }),
}));
// Match the repo's route-handler unit-test boundary: support impersonation has
// its own tests; this fixture exercises ordinary authenticated user requests.
vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));
vi.mock("@traceroot/github", () => ({
  getInstallationToken: (...args: unknown[]) => fixture.mint(...args),
}));

import { NextRequest } from "./next-server.ts";
import { POST as messagePOST } from "../../../../ui/src/app/api/projects/[projectId]/ai/sessions/[sessionId]/messages/route.ts";
import { GET as tokenGET } from "../../../../ui/src/app/api/github/token/route.ts";
import { SandboxRegistry } from "../../src/executors/registry.ts";
import { DockerExecutor } from "../../src/executors/docker.ts";
import { DaytonaExecutor } from "../../src/executors/daytona.ts";
import { createGitCloneTool } from "../../src/tools/git-clone.ts";
import { createBashTool } from "../../src/tools/sandbox.ts";
import type { Executor } from "../../src/executors/interface.ts";

const observations: unknown[] = [];
const providers = [
  ["docker", DockerExecutor.prototype.hasNativeGit],
  ["daytona", DaytonaExecutor.prototype.hasNativeGit],
] as const;

function sandbox(nativeGit: () => boolean) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const state = { simulatedGhCredential: false };
  const executor: Executor = {
    init: async () => {},
    isReady: () => true,
    getWorkspacePath: () => "/workspace",
    hasNativeGit: nativeGit,
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    readFile: async (path) => files.get(path) ?? "",
    cloneRepo: async () => {},
    destroy: async () => {
      state.simulatedGhCredential = false;
      files.clear();
    },
    exec: async (command) => {
      commands.push(command);
      if (command.includes("gh auth login --with-token")) {
        // Model gh's persisted authentication; no shell/gh client is executed.
        state.simulatedGhCredential = files.get("/tmp/.gh_token") === fixture.token;
      }
      if (command.includes("rm") && command.includes("/tmp/.gh_token"))
        files.delete("/tmp/.gh_token");
      return { stdout: "SIMULATED_EXECUTOR_RESULT", stderr: "", code: 0 };
    },
  };
  return { executor, state, commands };
}

async function post() {
  const request = new NextRequest(
    "http://ui.fixture/api/projects/research-project/ai/sessions/research-session/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Research fixture; no inference" }),
    },
  );
  return messagePOST(request as never, {
    params: Promise.resolve({ projectId: fixture.projectId, sessionId: "research-session" }),
  });
}

async function clone(executor: Executor) {
  await createGitCloneTool(fixture.workspaceId, "http://ui.fixture", executor).execute("research", {
    label: "fixture",
    repo: "research/fixture",
  });
}

beforeEach(() => {
  fixture.role = "MEMBER";
  fixture.forwarded = [];
  fixture.mint
    .mockReset()
    .mockResolvedValue({ token: fixture.token, expires_at: "2100-01-01T00:00:00Z" });
  vi.stubEnv("INTERNAL_API_SECRET", "fixture-internal-secret");
  vi.stubEnv("DEMO_WORKSPACE_ID", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://ui.fixture/api/github/token?")) {
        return tokenGET(new NextRequest(url, init) as never);
      }
      if (url.startsWith("http://localhost:8100/api/v1/projects/")) {
        fixture.forwarded.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) });
        return new Response("data: research-fixture\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error("External network is not allowed in this harness: " + url);
    }),
  );
});

describe("#2652 research: current production handlers with isolated boundaries", () => {
  it.each(providers)(
    "fresh viewer reaches workspace credential setup (%s)",
    async (provider, nativeGit) => {
      fixture.role = "VIEWER";
      const response = await post();
      expect(response.status).toBe(200);
      const box = sandbox(nativeGit);
      await clone(box.executor);
      expect(fixture.mint).toHaveBeenCalledTimes(1);
      expect(fixture.mint.mock.calls[0]).toHaveLength(3);
      expect(box.state.simulatedGhCredential).toBe(true);
      observations.push({
        case: "fresh-viewer",
        provider,
        proxyStatus: response.status,
        tokenMintCount: fixture.mint.mock.calls.length,
        ghLoginCommandEmitted: box.commands.some((c) => c.includes("gh auth login")),
      });
    },
  );

  for (const initialRole of ["MEMBER", "ADMIN"]) {
    it.each(providers)(
      `${initialRole} downgraded to VIEWER retains the same sandbox without another clone (%s)`,
      async (provider, nativeGit) => {
        fixture.role = initialRole;
        const boxes: ReturnType<typeof sandbox>[] = [];
        const registry = new SandboxRegistry({
          idleTtlMs: 30 * 60_000,
          create: () => {
            const box = sandbox(nativeGit);
            boxes.push(box);
            return box.executor;
          },
        });
        expect((await post()).status).toBe(200);
        const first = registry.acquire("research-session");
        await clone(first);
        expect(boxes[0].state.simulatedGhCredential).toBe(true);
        fixture.role = "VIEWER";
        const response = await post();
        expect(response.status).toBe(200);
        const reused = registry.acquire("research-session");
        expect(reused).toBe(first);
        const mintCount = fixture.mint.mock.calls.length;
        // Deliberately no git_clone call on this turn. The current bash tool has
        // no role input and passes the command through to the supplied executor.
        const command = "gh pr create --repo research/fixture --title fixture --body fixture";
        await createBashTool(reused).execute("research", { label: "simulated write", command });
        expect(boxes[0].commands.at(-1)).toBe(command);
        expect(boxes[0].state.simulatedGhCredential).toBe(true);
        expect(fixture.mint.mock.calls.length).toBe(mintCount);
        expect(fixture.forwarded.at(-1)?.headers["x-user-id"]).toBe(fixture.userId);
        expect(Object.keys(fixture.forwarded.at(-1)!.headers).some((h) => h.includes("role"))).toBe(
          false,
        );
        observations.push({
          case: "role-downgrade",
          provider,
          initialRole,
          finalRole: fixture.role,
          sameUser: fixture.userId,
          proxyStatus: response.status,
          sandboxReused: reused === first,
          newCloneOrTokenMintOnViewerTurn: false,
          simulatedCredentialRetained: boxes[0].state.simulatedGhCredential,
          writeCommandForwardedToMockExecutor: true,
        });
        await registry.release("research-session");
        const replacement = registry.acquire("research-session");
        expect(replacement).not.toBe(first);
        expect(boxes[1].state.simulatedGhCredential).toBe(false);
        await registry.destroyAll();
      },
    );
  }

  it("denies a viewer's browser token request but accepts the workspace's internal request", async () => {
    fixture.role = "VIEWER";
    const browser = await tokenGET(
      new NextRequest(
        "http://ui.fixture/api/github/token?workspaceId=research-workspace&repo=research/fixture",
      ) as never,
    );
    expect(browser.status).toBe(403);
    expect(fixture.mint).not.toHaveBeenCalled();
    const internal = await tokenGET(
      new NextRequest("http://ui.fixture/api/github/token?repo=research/fixture", {
        headers: {
          "x-workspace-id": fixture.workspaceId,
          "X-Internal-Secret": "fixture-internal-secret",
        },
      }) as never,
    );
    expect(internal.status).toBe(200);
    expect(fixture.mint).toHaveBeenCalledTimes(1);
    observations.push({
      case: "token-boundary-control",
      browserStatus: browser.status,
      internalStatus: internal.status,
    });
  });

  it("denies the message when workspace membership has been removed", async () => {
    fixture.role = null;
    expect((await post()).status).toBe(403);
    expect(fixture.forwarded).toHaveLength(0);
  });

  it("denies demo viewer messages via the actual demo guard", async () => {
    fixture.role = "VIEWER";
    vi.stubEnv("DEMO_WORKSPACE_ID", fixture.workspaceId);
    expect((await post()).status).toBe(403);
    expect(fixture.forwarded).toHaveLength(0);
  });
});

afterAll(() => {
  writeFileSync(
    new URL("./results.json", import.meta.url),
    JSON.stringify(
      {
        sourceCommit: "b6c6b1055904c8ae789e358e830b7d3308fab078",
        real: [
          "message proxy handler",
          "auth helpers and role comparator",
          "demo guard",
          "token handler and internal-secret verification",
          "SandboxRegistry",
          "git_clone and credential setup functions",
          "bash tool",
        ],
        mocked: [
          "Prisma data",
          "authenticated browser session",
          "support impersonation wrapper",
          "installation token mint",
          "agent SSE upstream",
          "sandbox exec/files/clone and persisted gh authentication model",
          "Next request/response shim",
        ],
        notExercised: [
          "GitHub API authorization",
          "actual gh CLI",
          "Docker daemon",
          "Daytona service",
          "Hono agent route",
          "PostgreSQL",
          "provider inference",
        ],
        providerCoverage:
          "Docker/Daytona hasNativeGit predicates exercised on mock executors. Both return true and select the current native-git credential setup path. This is not transport/integration coverage of either provider.",
        observations,
      },
      null,
      2,
    ),
  );
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
