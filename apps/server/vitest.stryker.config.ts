import { defineConfig } from "vitest/config";

/** Stryker 专用的 vitest 配置：只收试点文件的直接单测，排除 chdir/子进程类用例（worker 不支持）。 */
export default defineConfig({
  test: {
    include: [
      "src/agents/claude/claudeProtocol.test.ts",
      "src/agents/claude/agentErrorText.test.ts",
      "src/session/sessionManager.test.ts",
    ],
  },
});
