import { defineConfig } from "vitest/config";

/** 仓库根：门禁自研脚本（tools/）的单元测试配置——与业务测试分开跑（pnpm test:tools）。 */
export default defineConfig({
  test: { include: ["tools/**/*.test.ts"] },
});
