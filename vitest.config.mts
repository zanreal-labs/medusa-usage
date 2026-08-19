import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      // `sdk.ts` is a client construction over `import.meta.env` and has nothing
      // to assert; the rest of the admin extension is either a tested pure module
      // or a component rendered by the empty-state tests.
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/.medusa/**",
        "**/node_modules/**",
        "src/admin/lib/sdk.ts",
      ],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      provider: "v8",
    },
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
