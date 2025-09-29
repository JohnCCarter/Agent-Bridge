import { z } from "zod";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { fetch } from "undici";
import semver from "semver";
import { FSWhitelist } from "../security/fsWhitelist.js";

export const pkgAddSchema = z.object({
  cwd: z.string().default(process.cwd()),
  pkg: z.string(),
  dev: z.boolean().default(false),
  manager: z.enum(["npm", "pnpm"]).default("npm")
});

export const dependencyScanSchema = z.object({
  cwd: z.string().default(process.cwd()),
  scanPaths: z.array(z.string()).default(["src"]),
  includeDev: z.boolean().default(false),
  checkLatest: z.boolean().default(true),
  registry: z.string().default("https://registry.npmjs.org")
});

type PkgJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function isModuleSpecifier(s: string) {
  return !!s && !s.startsWith(".") && !s.startsWith("/") && !s.startsWith("node:");
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
}

async function walkFiles(root: string, whitelist: FSWhitelist, acc: string[] = []): Promise<string[]> {
  whitelist.ensureAllowed(root);
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    if (/\.(m?[jt]s|tsx|jsx)$/.test(root)) acc.push(root);
    return acc;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      await walkFiles(p, whitelist, acc);
    } else if (e.isFile() && /\.(m?[jt]s|tsx|jsx)$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

async function collectUsedModules(files: string[]): Promise<Set<string>> {
  const used = new Set<string>();
  for (const file of files) {
    const src = await fs.readFile(file, "utf8").catch(() => "");
    // naive parse for import/export/require
    const importRe = /(?:import|export)\s+(?:[^'"]*from\s+)?["']([^"']+)["']/g;
    const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src))) {
      const mod = m[1];
      if (isModuleSpecifier(mod)) {
        used.add(mod.split("/")[0] === "@"
          ? `${mod.split("/")[0]}/${mod.split("/")[1]}`
          : mod.split("/")[0]);
      }
    }
    while ((m = requireRe.exec(src))) {
      const mod = m[1];
      if (isModuleSpecifier(mod)) {
        used.add(mod.split("/")[0] === "@"
          ? `${mod.split("/")[0]}/${mod.split("/")[1]}`
          : mod.split("/")[0]);
      }
    }
  }
  return used;
}

async function getInstalledVersion(cwd: string, name: string): Promise<string | null> {
  const p = path.join(cwd, "node_modules", name, "package.json");
  try {
    const txt = await fs.readFile(p, "utf8");
    const pkg = JSON.parse(txt) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestVersion(registry: string, name: string): Promise<string | null> {
  try {
    const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(name).replace("%40", "@")}/latest`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export async function dependency_add(input: z.infer<typeof pkgAddSchema>) {
  // Suggestion only (we don't execute installs here)
  const flag = input.manager === "npm" ? (input.dev ? "--save-dev" : "--save") : input.dev ? "-D" : "";
  return {
    content: [
      {
        type: "text",
        text: `Run: ${input.manager} install ${flag ? flag + " " : ""}${input.pkg} (cwd: ${input.cwd})`
      }
    ]
  };
}

export async function dependency_scan(input: z.infer<typeof dependencyScanSchema>, whitelist: FSWhitelist) {
  const pkgPath = path.join(input.cwd, "package.json");
  whitelist.ensureAllowed(pkgPath);
  const pkg = await readJson<PkgJson>(pkgPath);
  if (!pkg) {
    return { content: [{ type: "text", text: `No package.json found at ${pkgPath}` }] };
  }

  const declared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...(input.includeDev ? Object.keys(pkg.devDependencies ?? {}) : [])
  ]);

  // gather used modules
  const files: string[] = [];
  for (const p of input.scanPaths) {
    const abs = path.resolve(input.cwd, p);
    const sub = await walkFiles(abs, whitelist);
    files.push(...sub);
  }
  const used = await collectUsedModules(files);

  const missing = [...used].filter((u) => !declared.has(u));
  const unused = [...declared].filter((d) => !used.has(d));

  // versions
  const versions: Array<{
    name: string;
    declared: string | null;
    installed: string | null;
    latest: string | null;
    upToDate: boolean | null;
  }> = [];

  if (input.checkLatest) {
    for (const name of declared) {
      const declaredRange =
        (pkg.dependencies ?? {})[name] ?? (input.includeDev ? (pkg.devDependencies ?? {})[name] : undefined) ?? null;
      const installed = await getInstalledVersion(input.cwd, name);
      const latest = await getLatestVersion(input.registry, name);
      const upToDate =
        installed && latest ? semver.valid(installed) && semver.valid(latest) ? semver.gte(installed, latest) : null : null;

      versions.push({
        name,
        declared: declaredRange,
        installed,
        latest,
        upToDate
      });
    }
  }

  const report = {
    scan: {
      cwd: input.cwd,
      fileCount: files.length
    },
    missing,
    unused,
    versions
  };

  return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
}