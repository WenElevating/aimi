import { defineConfig } from "vitest/config";

/** M0 测试配置：单文件进程足够（Node 单进程事件循环与生产一致）。 */
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"] },
});
