import { Octokit } from "@octokit/rest";

const REPO_OWNER = process.env.GITHUB_REPO_OWNER || "oiiaioiiiai57";
const REPO_NAME  = process.env.GITHUB_REPO_NAME || "pejxjcykzlqjsloshvhbb";

let octokit = null;

function getOctokit() {
  if (!octokit) {
    octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  }
  return octokit;
}

// Simple in-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 30_000; // 30s — reduces GitHub API calls significantly

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }
function cacheInvalidate(key) { cache.delete(key); }

// ── RAW FILE OPS ─────────────────────────────────────────────

async function getFile(path) {
  try {
    const res = await getOctokit().rest.repos.getContent({
      owner: REPO_OWNER, repo: REPO_NAME, path,
      headers: { "If-None-Match": "" }, // bypass GitHub CDN cache
    });
    let content;
    if (res.data.encoding === "base64") {
      content = Buffer.from(res.data.content.replace(/\n/g,""), "base64").toString("utf8");
    } else if (res.data.download_url) {
      // Large file (>1MB) - fetch raw content directly
      const raw = await fetch(`${res.data.download_url}?t=${Date.now()}`);
      content = await raw.text();
    } else {
      content = res.data.content || "";
    }
    return { content, sha: res.data.sha };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function writeFile(path, content, message = "Update") {
  cacheInvalidate(path);
  const existing = await getFile(path);
  if (existing) {
    await getOctokit().rest.repos.createOrUpdateFileContents({
      owner: REPO_OWNER, repo: REPO_NAME, path,
      message, content: Buffer.from(content).toString("base64"),
      sha: existing.sha,
    });
  } else {
    await getOctokit().rest.repos.createOrUpdateFileContents({
      owner: REPO_OWNER, repo: REPO_NAME, path,
      message, content: Buffer.from(content).toString("base64"),
    });
  }
}

// ── JSON OPS ─────────────────────────────────────────────────

export async function readJson(path, fallback = {}) {
  const cached = cacheGet(path);
  if (cached !== null) return cached;
  const file = await getFile(path);
  if (!file) return fallback;
  try {
    const data = JSON.parse(file.content);
    cacheSet(path, data);
    return data;
  } catch { return fallback; }
}

export async function writeJson(path, data) {
  cacheInvalidate(path);
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "Update " + path);
  cacheSet(path, data);
}

// ── TEXT STOCK OPS ────────────────────────────────────────────

export async function readLines(path) {
  const cached = cacheGet(path);
  if (cached !== null) return cached;
  const file = await getFile(path);
  if (!file) return [];
  const lines = file.content.split("\n").map(l => l.trim()).filter(Boolean);
  cacheSet(path, lines);
  return lines;
}

export async function writeLines(path, lines) {
  cacheInvalidate(path);
  // Also invalidate parent dir cache
  const dirPath = path.split("/").slice(0,-1).join("/");
  if (dirPath) cacheInvalidate("dir:" + dirPath);
  await writeFile(path, lines.join("\n") + "\n", "Update stock");
  cacheSet(path, lines);
}

// ── LIST DIR ─────────────────────────────────────────────────

export async function listDir(path) {
  const cached = cacheGet("dir:" + path);
  if (cached !== null) return cached;
  try {
    const res = await getOctokit().rest.repos.getContent({
      owner: REPO_OWNER, repo: REPO_NAME, path,
    });
    const files = Array.isArray(res.data) ? res.data : [res.data];
    cacheSet("dir:" + path, files);
    return files;
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}
