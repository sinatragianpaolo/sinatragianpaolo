#!/usr/bin/env node
/**
 * update-stats.mjs
 *
 * For each configured repo:
 *   1. Blobless clone (only commit metadata, no file content) → fast
 *   2. Count commits by author with git log --all (all branches)
 *      - All time
 *      - Current year (from Jan 1)
 *      - Last calendar month
 *
 * Updates three tables in README.md between COMMIT_STATS_START/END markers.
 * Each table has 5 columns: Area | Commits | + Lines added | − Lines removed | Δ Net growth
 * Note: --numstat triggers lazy blob fetching on blobless clones (slower but correct).
 *
 * Requires env var: GH_PAT (repo + read:org scopes)
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, "..", "README.md");
const CLONE_DIR = "/tmp/readme-stats-repos";

const AUTHOR_EMAIL = "gianpaolosinatra@gmail.com";
const GH_PAT = process.env.GH_PAT;

if (!GH_PAT) {
  console.error("Missing GH_PAT environment variable");
  process.exit(1);
}

// ─── Repo list ────────────────────────────────────────────────────────────────

const REPOS = [
  // Backend API
  { org: "AppQuality", name: "tryber-api" },
  { org: "AppQuality", name: "unguess-api" },
  { org: "AppQuality", name: "clickday-api" },
  { org: "AppQuality", name: "device-api" },
  // Database
  { org: "AppQuality", name: "database" },
  // Frontend
  { org: "AppQuality", name: "unguess-react" },
  { org: "AppQuality", name: "tryber-react" },
  { org: "AppQuality", name: "tryber-backoffice" },
  { org: "AppQuality", name: "click-day" },
  { org: "AppQuality", name: "unguess-design-system" },
  { org: "AppQuality", name: "appquality-design-system" },
  { org: "AppQuality", name: "design-systems" },
  { org: "AppQuality", name: "unguess-docs" },
  { org: "AppQuality", name: "unguess-cms-api" },
  // Infrastructure & DevOps
  { org: "AppQuality", name: "unguess-infrastructure" },
  { org: "AppQuality", name: "tryber-infrastructure" },
  { org: "AppQuality", name: "ai-service" },
  { org: "AppQuality", name: "bottleneck-service" },
  { org: "AppQuality", name: "notification-service" },
  { org: "AppQuality", name: "crowd_wp" },
  { org: "AppQuality", name: "crowd_wp_platform" },
  { org: "AppQuality", name: "ffmpeg-encode" },
  { org: "AppQuality", name: "create-cuf-jotform" },
  { org: "AppQuality", name: "save-cuf-from-jotform" },
  { org: "AppQuality", name: "update-leaderboard-lambda" },
  { org: "AppQuality", name: "appq-integration-center" },
  { org: "AppQuality", name: "appq-integration-center-csv-addon" },
  // AI & Automation
  { org: "AppQuality", name: "mastra" },
  { org: "AppQuality", name: "assessment-data" },
  { org: "AppQuality", name: "bug-review-multiagent" },
  { org: "AppQuality", name: "ML_bug_review" },
  // Tooling & Libraries
  { org: "AppQuality", name: "openapi-sort" },
  { org: "AppQuality", name: "createDemoEnvironment" },
  { org: "AppQuality", name: "prototype-modularization" },
  // Personal Projects
  { org: "sinatragianpaolo", name: "arduino-weather-station" },
];

// ─── Category mapping ─────────────────────────────────────────────────────────

const CATEGORIES = {
  "🔧 Backend API": [
    "tryber-api",
    "unguess-api",
    "clickday-api",
    "device-api",
  ],
  "🗄️ Database": ["database"],
  "⚛️ Frontend": [
    "unguess-react",
    "tryber-react",
    "tryber-backoffice",
    "click-day",
    "unguess-design-system",
    "appquality-design-system",
    "design-systems",
  ],
  "☁️ Infrastructure & DevOps": [
    "unguess-infrastructure",
    "tryber-infrastructure",
    "ai-service",
    "bottleneck-service",
    "notification-service",
    "crowd_wp",
    "crowd_wp_platform",
    "ffmpeg-encode",
    "create-cuf-jotform",
    "save-cuf-from-jotform",
    "update-leaderboard-lambda",
    "appq-integration-center",
    "appq-integration-center-csv-addon",
  ],
  "🤖 AI & Automation": [
    "mastra",
    "assessment-data",
    "bug-review-multiagent",
    "ML_bug_review",
  ],
  "🧰 Tooling & Libraries": [
    "openapi-sort",
    "createDemoEnvironment",
    "prototype-modularization",
    "unguess-cms-api",
    "unguess-docs",
  ],
  "🏠 Personal Projects": [
    "arduino-weather-station",
  ],
};

// ─── Date ranges ──────────────────────────────────────────────────────────────

const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth(); // 0-based

const yearStart = `${currentYear}-01-01`;

const lastMonthStart = new Date(currentYear, currentMonth - 1, 1);
const lastMonthEnd = new Date(currentYear, currentMonth, 1);
const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
const lastMonthEndStr = lastMonthEnd.toISOString().split("T")[0];

const lastMonthLabel = lastMonthStart.toLocaleDateString("en-US", {
  month: "long",
  year: "numeric",
});
const currentYearLabel = String(currentYear);

// ─── Git helpers ──────────────────────────────────────────────────────────────

function cloneRepo(org, name) {
  const dest = join(CLONE_DIR, name);
  if (existsSync(dest)) return dest;

  const url = `https://x-access-token:${GH_PAT}@github.com/${org}/${name}.git`;
  try {
    execSync(
      `git clone --bare --filter=blob:none --quiet "${url}" "${dest}"`,
      { stdio: "pipe" }
    );
    console.log(`  ✓ ${name}`);
    return dest;
  } catch {
    console.warn(`  ✗ ${name} (not accessible)`);
    return null;
  }
}

function countCommits(repoPath, after = null, before = null) {
  let cmd = `git -C "${repoPath}" log --author="${AUTHOR_EMAIL}" --all --oneline`;
  if (after) cmd += ` --after="${after}"`;
  if (before) cmd += ` --before="${before}"`;
  try {
    const out = execSync(cmd, { stdio: "pipe" }).toString().trim();
    return out ? out.split("\n").length : 0;
  } catch {
    return 0;
  }
}

function countLines(repoPath, after = null, before = null) {
  let cmd = `git -C "${repoPath}" log --author="${AUTHOR_EMAIL}" --all --numstat --pretty=format:`;
  if (after) cmd += ` --after="${after}"`;
  if (before) cmd += ` --before="${before}"`;
  try {
    const out = execSync(cmd, { stdio: "pipe" }).toString();
    let added = 0, removed = 0;
    for (const line of out.split("\n")) {
      const parts = line.trim().split("\t");
      // skip binary files (shown as "-") and empty lines
      if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        added += parseInt(parts[0], 10);
        removed += parseInt(parts[1], 10);
      }
    }
    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

mkdirSync(CLONE_DIR, { recursive: true });

console.log("Cloning repos (blobless)...");
const repoPaths = {};
for (const { org, name } of REPOS) {
  repoPaths[name] = cloneRepo(org, name);
}

console.log("\nCounting commits and lines...");
// stats[repoName] = { allTime, year, lastMonth }
// each period = { commits, added, removed }
const stats = {};

for (const { name } of REPOS) {
  const path = repoPaths[name];
  if (!path) {
    const empty = { commits: 0, added: 0, removed: 0 };
    stats[name] = { allTime: empty, year: empty, lastMonth: empty };
    continue;
  }

  const allTimeLines    = countLines(path);
  const yearLines       = countLines(path, yearStart);
  const lastMonthLines  = countLines(path, lastMonthStartStr, lastMonthEndStr);

  stats[name] = {
    allTime:   { commits: countCommits(path),                                   ...allTimeLines },
    year:      { commits: countCommits(path, yearStart),                         ...yearLines },
    lastMonth: { commits: countCommits(path, lastMonthStartStr, lastMonthEndStr), ...lastMonthLines },
  };

  const s = stats[name];
  console.log(
    `  ${name}: ${s.allTime.commits} commits / +${s.allTime.added} −${s.allTime.removed} lines`
  );
}

// ─── Build tables ─────────────────────────────────────────────────────────────

function buildTable(getPeriod) {
  const rows = [];
  let grandCommits = 0, grandAdded = 0, grandRemoved = 0;

  for (const [category, repos] of Object.entries(CATEGORIES)) {
    let commits = 0, added = 0, removed = 0;
    for (const r of repos) {
      const p = getPeriod(r);
      if (p) { commits += p.commits; added += p.added; removed += p.removed; }
    }
    if (commits > 0 || added > 0) {
      rows.push({ category, commits, added, removed });
      grandCommits += commits;
      grandAdded   += added;
      grandRemoved += removed;
    }
  }

  rows.sort((a, b) => b.commits - a.commits);

  const fmt = (n) => n.toLocaleString("en-US");
  const header = `| Area | Commits | + Lines added | − Lines removed | Δ Net growth |\n|---|---|---|---|---|\n`;
  const body = rows
    .map((r) => `| ${r.category} | ${fmt(r.commits)} | ${fmt(r.added)} | ${fmt(r.removed)} | +${fmt(r.added - r.removed)} |`)
    .join("\n");
  const footer = `\n| **Total** | **${fmt(grandCommits)}** | **${fmt(grandAdded)}** | **${fmt(grandRemoved)}** | **+${fmt(grandAdded - grandRemoved)}** |`;

  return `${header}${body}${footer}`;
}

const updatedAt = now.toLocaleDateString("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const block = `
> Last updated on ${updatedAt}

### 📊 All time
${buildTable((r) => stats[r]?.allTime)}

### 🗓 ${currentYearLabel}
${buildTable((r) => stats[r]?.year)}

### 📆 ${lastMonthLabel}
${buildTable((r) => stats[r]?.lastMonth)}

`;

// ─── Update README ────────────────────────────────────────────────────────────

const START = "<!-- COMMIT_STATS_START -->";
const END = "<!-- COMMIT_STATS_END -->";

let readme = readFileSync(README_PATH, "utf-8");
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);

if (startIdx === -1 || endIdx === -1) {
  console.error("Markers not found in README.md");
  process.exit(1);
}

readme =
  readme.slice(0, startIdx + START.length) +
  block +
  readme.slice(endIdx);

writeFileSync(README_PATH, readme, "utf-8");
console.log("\nREADME.md updated successfully!");
