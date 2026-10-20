import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@traceroot\/core$/, replacement: path("./core-stub.ts") },
      { find: /^@traceroot\/github$/, replacement: path("./github-stub.ts") },
      { find: "next/server", replacement: path("./next-server.ts") },
      { find: "@", replacement: path("../../../../ui/src") },
    ],
  },
  test: {
    root: path("."),
    environment: "node",
    env: { AGENT_SERVICE_URL: "http://localhost:8100" },
    include: ["research.repro.ts"],
    maxWorkers: 1,
  },
});
