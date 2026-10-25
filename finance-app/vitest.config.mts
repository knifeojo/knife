import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/empty.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      DATABASE_URL: "file:./test.db",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      NODE_ENV: "test",
      // No real model is ever called from tests: no cloud key, default routing.
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      AI_PROVIDER: "",
      AI_CATEGORIZE: "",
      AI_ESCALATION: "",
      AI_INSIGHTS: "",
      AI_CHAT: "",
      OLLAMA_BASE_URL: "",
      OLLAMA_MODEL: "",
      OLLAMA_ESCALATION_MODEL: "",
    },
    fileParallelism: false,
  },
});
