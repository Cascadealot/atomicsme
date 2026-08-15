import js from "@eslint/js";
import tseslint from "typescript-eslint";

const maintainedTypeScript = [
  "src/**/*.ts",
  "extensions/**/*.ts",
  "workflows/**/*.ts",
  "examples/**/*.ts",
  "test/**/*.ts",
];

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: maintainedTypeScript,
    ...js.configs.recommended,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: maintainedTypeScript,
  })),
];
