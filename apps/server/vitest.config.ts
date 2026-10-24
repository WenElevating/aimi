import { defineConfig } from "vitest/config";

/**
 * 测试配置：单文件进程足够（Node 单进程事件循环与生产一致）。
 * 分层：`src/` 单元测试（无真实子进程）与 `__tests__/` e2e（真实 ws + 假 CLI 子进程）
 * 分开跑——`pnpm test:unit` / `pnpm test:e2e` 各自选择，`pnpm test` 全量。
 * e2e 有真实子进程与端口占用，必须 `--no-file-parallelism` 串行（SDK 子进程并发会
 * 资源争抢批量假失败）；单测沿用同一约束保持行为一致。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 覆盖率统计口径：只统计生产源码（测试文件、类型声明、生成的门面不入分母）。
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
