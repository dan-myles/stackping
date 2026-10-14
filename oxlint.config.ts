import { defineConfig } from "oxlint"

export default defineConfig({
  plugins: ["typescript"],
  rules: {
    "eslint/no-debugger": "error",
    "eslint/no-unused-vars": "off",
    "eslint/no-var": "error",
    "eslint/prefer-const": "error",
    "eslint/prefer-template": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-import-type-side-effects": "error",
  },
})
