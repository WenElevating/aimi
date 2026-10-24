import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

/**
 * ESLint flat config：门禁只做 correctness 与安全底线，不做风格（风格归 prettier）。
 * 口径：只对暂存文件跑（lint-staged），存量代码一次性不强改；规则集取 recommended
 * 的类型关闭子集（快）+ security 插件的对象注入/子进程注入两类高信噪比规则。
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "apps/mobile/**", // Dart 侧由 flutter analyze 负责，ESLint 不越界
      "docs/**",
      "prototypes/**",
    ],
  },
  ...tseslint.configs.recommended
    .filter((config) => !("files" in config) || config.files !== undefined)
    .map((config) => ({
      ...config,
      files: ["**/*.ts", "**/*.mjs"],
    })),
  {
    files: ["**/*.ts", "**/*.mjs"],
    plugins: { security },
    rules: {
      "security/detect-object-injection": "error",
      "security/detect-child-process": "error",
      // correctness 底线： recommended 里的错误级规则保持默认；
      // 以下两类在测试/工具脚本中放宽（测试断言 non-null 是惯用法）。
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
