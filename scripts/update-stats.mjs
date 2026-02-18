#!/usr/bin/env node
/**
 * update-stats.mjs
 *
 * Queries the GitHub GraphQL API to count commits by year and repo,
 * then updates the COMMIT_STATS_START / COMMIT_STATS_END section in README.md.
 *
 * Requires env var: GH_PAT (Personal Access Token with read:org + repo scopes)
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, "..", "README.md");

const USERNAME = "sinatragianpaolo";
const GH_PAT = process.env.GH_PAT;

if (!GH_PAT) {
  console.error("Missing GH_PAT environment variable");
  process.exit(1);
}

// Map each repo to a display category
const CATEGORIES = {
  "🔧 Backend API": [
    "tryber-api",
    "unguess-api",
    "clickday-api",
    "tryber-device-api",
  ],
  "🗄️ Database": ["databases"],
  "⚛️ Frontend": [
    "unguess-react",
    "tryber-react-frontoffice",
    "tryber-react-backoffice",
    "clickday-react",
    "unguess-design-system",
    "tryber-design-system",
  ],
  "☁️ Infrastructure & DevOps": [
    "unguess-infrastructure",
    "tryber-infrastructure",
    "unguess-ai-service",
    "unguess-bottleneck-service",
    "unguess-infrastructure-notification-service",
    "tryber-docker",
    "tryber-ffmpeg-encode",
    "tryber-create-cuf-jotform",
    "tryber-save-cuf-from-jotform",
    "lambda-update-leaderboard-lambda",
  ],
  "🤖 AI & Automation": [
    "unguess-infrastructure-mastra",
    "unguess-experimental",
    "assessment-data",
  ],
  "🧰 Tooling & Libraries": [
    "unguess-utilities",
    "script-create-demo-environment",
    "script-openapi-sort",
    "scripter",
    "tryber-simple-node-db-jest-app",
    "parameter-store-manager",
  ],
};

async function graphql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_PAT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (json.errors) {
    throw new Error(JSON.stringify(json.errors, null, 2));
  }

  return json.data;
}

async function getContributionsForYear(from, to) {
  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            contributions { totalCount }
            repository {
              name
              owner { login }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await graphql(query, { login: USERNAME, from, to });
    return data.user.contributionsCollection.commitContributionsByRepository;
  } catch (e) {
    console.warn(`Could not fetch contributions for ${from}:`, e.message);
    return [];
  }
}

async function getAllContributions() {
  const currentYear = new Date().getFullYear();
  const totals = {};

  for (let year = currentYear - 4; year <= currentYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to =
      year === currentYear
        ? new Date().toISOString()
        : `${year}-12-31T23:59:59Z`;

    console.log(`Fetching ${year}...`);
    const contribs = await getContributionsForYear(from, to);

    for (const { contributions, repository } of contribs) {
      const name = repository.name;
      totals[name] = (totals[name] || 0) + contributions.totalCount;
    }
  }

  return totals;
}

function buildTable(contributions) {
  const rows = [];
  let grandTotal = 0;

  for (const [category, repos] of Object.entries(CATEGORIES)) {
    let categoryTotal = 0;

    for (const repo of repos) {
      categoryTotal += contributions[repo] || 0;
    }

    if (categoryTotal > 0) {
      rows.push({ category, total: categoryTotal });
      grandTotal += categoryTotal;
    }
  }

  rows.sort((a, b) => b.total - a.total);

  const now = new Date().toLocaleDateString("it-IT", {
    month: "long",
    year: "numeric",
  });

  const header = `| Area | Commits |\n|---|---|\n`;
  const body = rows.map((r) => `| ${r.category} | ${r.total.toLocaleString("it-IT")} |`).join("\n");
  const footer = `\n| **Totale** | **${grandTotal.toLocaleString("it-IT")}** |`;
  const note = `\n> Aggiornato automaticamente — ${now}\n\n`;

  return `\n${note}${header}${body}${footer}\n`;
}

function updateReadme(table) {
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
    table +
    readme.slice(endIdx);

  writeFileSync(README_PATH, readme, "utf-8");
  console.log("README.md updated.");
}

const contributions = await getAllContributions();
console.log("Contributions by repo:", contributions);

const table = buildTable(contributions);
updateReadme(table);
