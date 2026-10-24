import { defineConfig } from "vitest/config";

/** protocol 测试与覆盖率配置：统计 src 生产源码（zod 契约），排除测试文件。 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
