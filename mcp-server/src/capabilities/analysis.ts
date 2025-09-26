import { ESLint } from "eslint";
import { z } from "zod";
import path from "node:path";
import { FSWhitelist } from "../security/fsWhitelist.js";

export const codeAnalysisSchema = z.object({
  patterns: z.array(z.string()).default(["src/**/*.{ts,tsx,js,jsx}", "**/*.{ts,tsx,js,jsx}"]),
  fix: z.boolean().default(false),
  formatter: z.string().default("stylish"),
  useProjectEslint: z.boolean().default(true),
  cwd: z.string().default(process.cwd())
});

export type CodeAnalysisInput = z.infer<typeof codeAnalysisSchema>;

function filterByWhitelist(results: ESLint.LintResult[], whitelist: FSWhitelist) {
  return results.filter((r) => {
    try {
      whitelist.ensureAllowed(r.filePath);
      return true;
    } catch {
      return false;
    }
  });
}

export async function code_analysis(input: CodeAnalysisInput, whitelist: FSWhitelist) {
  const options: ESLint.Options = input.useProjectEslint
    ? {
        cwd: input.cwd,
        fix: input.fix,
        useEslintrc: true
      }
    : {
        cwd: input.cwd,
        fix: input.fix,
        useEslintrc: false,
        baseConfig: {
          root: true,
          env: { es2022: true, node: true, browser: false },
          extends: ["eslint:recommended"],
          parserOptions: { ecmaVersion: "latest", sourceType: "module" },
          ignorePatterns: ["dist/**", "node_modules/**"]
        }
      };

  let eslint: ESLint;
  try {
    eslint = new ESLint(options);
  } catch (e) {
    // Fallback to minimal config if project config fails
    eslint = new ESLint({
      cwd: input.cwd,
      fix: input.fix,
      useEslintrc: false,
      baseConfig: {
        root: true,
        env: { es2022: true, node: true },
        extends: ["eslint:recommended"],
        parserOptions: { ecmaVersion: "latest", sourceType: "module" },
        ignorePatterns: ["dist/**", "node_modules/**"]
      }
    });
  }

  const results = await eslint.lintFiles(input.patterns);
  const filtered = filterByWhitelist(results, whitelist);
  if (input.fix) {
    await ESLint.outputFixes(filtered);
  }
  const formatter = await eslint.loadFormatter(input.formatter);
  const formatted = formatter.format(filtered);

  const summary = {
    errorCount: filtered.reduce((a, r) => a + r.errorCount, 0),
    warningCount: filtered.reduce((a, r) => a + r.warningCount, 0),
    files: filtered.map((r) => path.relative(input.cwd, r.filePath))
  };

  return {
    content: [
      { type: "text", text: JSON.stringify(summary, null, 2) },
      { type: "text", text: formatted }
    ]
  };
}