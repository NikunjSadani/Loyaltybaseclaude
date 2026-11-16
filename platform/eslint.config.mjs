import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Flaky-test guard rails (flaky-test sweep 2026-11-15): eslint-plugin-testing-library rules that catch the
// async-test patterns which flaked on the slower GitHub runner and blocked deploys — un-awaited async
// queries/utils/user events, `waitFor(() => getBy…)` instead of `findBy…`, side effects inside waitFor.
// The plugin is a devDependency that must be installed first:
//   npm install --prefix platform --save-dev --save-exact eslint-plugin-testing-library@7.16.2
// Until it is installed, lint runs WITHOUT these rules and prints a warning (never crashes the lint run).
let testingLibrary = null;
try {
  testingLibrary = (await import("eslint-plugin-testing-library")).default;
} catch {
  console.warn(
    "[eslint] eslint-plugin-testing-library is not installed — test-file flake rules are OFF. " +
      "Install: npm install --prefix platform --save-dev --save-exact eslint-plugin-testing-library@7.16.2",
  );
}

const testingLibraryConfig = testingLibrary
  ? [
      {
        files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**/*.{ts,tsx}"],
        plugins: { "testing-library": testingLibrary },
        rules: {
          // Every async query / util / user-event MUST be awaited (un-awaited = assertion races the render).
          "testing-library/await-async-queries": "error",
          "testing-library/await-async-utils": "error",
          "testing-library/await-async-events": ["error", { eventModule: "userEvent" }],
          "testing-library/no-await-sync-queries": "error",
          "testing-library/no-promise-in-fire-event": "error",
          // `await waitFor(() => expect(getBy…))` → `await findBy…` (autofixable).
          "testing-library/prefer-find-by": "error",
          // Side effects / snapshots inside waitFor re-run on every poll.
          "testing-library/no-wait-for-side-effects": "error",
          "testing-library/no-wait-for-snapshot": "error",
          "testing-library/no-global-regexp-flag-in-query": "error",
          // Advisory: one assertion per waitFor keeps the failure message pointed at the slow piece.
          "testing-library/no-wait-for-multiple-assertions": "warn",
          // Deliberately OFF/unset (style-only, very noisy on this suite, not flake-related):
          // prefer-screen-queries, no-node-access, no-container, render-result-naming-convention.
        },
      },
    ]
  : [];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...testingLibraryConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
