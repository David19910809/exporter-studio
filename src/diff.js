const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const METRIC_PATTERNS = [
  /prometheus\.MustNewConstMetric\s*\([^,]+,\s*[^,]+,\s*[^,]+,\s*"([^"]+)"/g,
  /promauto\.NewGauge\s*\(\s*prometheus\.GaugeOpts\s*\{[\s\S]*?Name:\s*"([^"]+)"/g,
  /promauto\.NewCounter\s*\(\s*prometheus\.CounterOpts\s*\{[\s\S]*?Name:\s*"([^"]+)"/g
];

function getGitDiff(cwd = process.cwd(), base = "HEAD") {
  try {
    return execFileSync("git", ["diff", "--stat", base], {
      cwd,
      encoding: "utf8"
    }).trim();
  } catch (error) {
    return "";
  }
}

function extractMetricsFromText(source) {
  const metrics = new Set();
  for (const pattern of METRIC_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      metrics.add(match[1]);
    }
  }
  return [...metrics].sort();
}

function extractMetricsFromDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const metrics = new Set();
  for (const file of walk(dir)) {
    if (file.endsWith(".go")) {
      for (const metric of extractMetricsFromText(fs.readFileSync(file, "utf8"))) {
        metrics.add(metric);
      }
    }
  }
  return [...metrics].sort();
}

function semanticDiff(beforeMetrics, afterMetrics, collectorChanges = []) {
  const before = new Set(beforeMetrics);
  const after = new Set(afterMetrics);
  const added = [...after].filter((metric) => !before.has(metric)).sort();
  const removed = [...before].filter((metric) => !after.has(metric)).sort();
  const impact = removed.length || collectorChanges.length > 1 ? "medium" : added.length ? "low" : "none";

  return {
    metrics_added: added,
    metrics_removed: removed,
    collector_changed: collectorChanges,
    risk_level: impact,
    added_metrics: added,
    removed_metrics: removed,
    collector_changes: collectorChanges,
    impact_level: impact
  };
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".elmp") continue;
    if (entry.isDirectory()) files.push(...walk(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

module.exports = {
  extractMetricsFromDir,
  extractMetricsFromText,
  getGitDiff,
  semanticDiff
};
