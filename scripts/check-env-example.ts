#!/usr/bin/env tsx
/**
 * Cross-checks process.env usage against .env.example.
 *
 * Scans all .ts/.js/.mjs files for process.env.X and import.meta.env.X references,
 * then verifies each variable appears in .env.example. Reports undeclared variables.
 *
 * Run: npx tsx scripts/check-env-example.ts
 * CI: Add to GitHub Actions workflow for PR checks
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = join(import.meta.dirname, "..");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "target", "frontend/public"];

// Variables intentionally not in root .env.example (frontend has its own .env.example)
const FRONTEND_PREFIXES = ["VITE_"];

// Variables that are environment-detection only, not configurable
const SKIP_VARS = ["NODE_ENV", "CI", "RENDER", "RENDER_SERVICE_ID", "HOME"];

interface Undeclared {
  file: string;
  line: number;
  variable: string;
  context: string;
}

function walkDir(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (SKIP_DIRS.some((skip) => fullPath.includes(skip))) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath, acc);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function extractVariables(filePath: string): { variable: string; line: number; context: string }[] {
  const content = readFileSync(filePath, "utf8");
  const vars: { variable: string; line: number; context: string }[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match process.env.VARIABLE_NAME
    const nodeMatches = line.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
    for (const match of nodeMatches) {
      vars.push({ variable: match[1], line: i + 1, context: line.trim() });
    }

    // Match import.meta.env.VARIABLE_NAME
    const viteMatches = line.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g);
    for (const match of viteMatches) {
      vars.push({ variable: match[1], line: i + 1, context: line.trim() });
    }
  }
  return vars;
}

// Main
const envExample = readFileSync(ENV_EXAMPLE, "utf8");

// Extract variable names from .env.example (lines matching VAR= or # VAR=)
const declaredVars = new Set<string>();
for (const line of envExample.split("\n")) {
  const match = line.match(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/);
  if (match) {
    declaredVars.add(match[1]);
  }
}

// Scan all source files
const files = walkDir(ROOT);
const undeclared: Undeclared[] = [];

for (const file of files) {
  const vars = extractVariables(file);
  for (const { variable, line, context } of vars) {
    if (SKIP_VARS.includes(variable)) continue;
    if (FRONTEND_PREFIXES.some((prefix) => variable.startsWith(prefix))) continue;
    if (!declaredVars.has(variable)) {
      undeclared.push({
        file: relative(ROOT, file),
        line,
        variable,
        context,
      });
    }
  }
}

if (undeclared.length === 0) {
  console.log("✓ All process.env variables are declared in .env.example");
  process.exit(0);
}

console.error(`\n✗ Found ${undeclared.length} undeclared environment variable(s) in .env.example:\n`);
const grouped: Record<string, Undeclared[]> = {};
for (const u of undeclared) {
  (grouped[u.variable] ??= []).push(u);
}

for (const [variable, refs] of Object.entries(grouped).sort()) {
  console.error(`  ${variable}`);
  for (const ref of refs) {
    console.error(`    ${ref.file}:${ref.line}  ${ref.context}`);
  }
  console.error();
}

process.exit(1);
