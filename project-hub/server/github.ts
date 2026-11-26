import { execFile } from "node:child_process";
import type { RpcInput } from "@getpaseo/plugin";
import type { resolveGithubRepos } from "../shared/github";

const TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 5 * 60 * 1000;
const AVATAR_SIZE = 40;
const AVATAR_MAX_BYTES = 64 * 1024;

interface RepoInfo {
  readonly canonical: string;
  readonly owner: string;
  readonly avatarUrl: string | null;
}

const repoCache = new Map<string, { value: RepoInfo | null; expiresAt: number }>();
const avatarCache = new Map<string, { value: string | null; expiresAt: number }>();

function ghRepo(owner: string, repo: string): Promise<{ fullName: string; avatarUrl: string | null } | null> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["api", `repos/${owner}/${repo}`, "--jq", "[.full_name, .owner.avatar_url] | @tsv"],
      { timeout: 10_000 },
      (error, stdout) => {
        const [fullName, avatarUrl] = (stdout?.toString().trim() ?? "").split("\t");
        resolve(error || !fullName ? null : { fullName, avatarUrl: avatarUrl || null });
      },
    );
  });
}

async function resolveRepo(remote: string): Promise<RepoInfo | null> {
  const now = Date.now();
  const hit = repoCache.get(remote);
  if (hit && hit.expiresAt > now) return hit.value;
  const match = /^github\.com\/([^/]+)\/([^/]+)$/.exec(remote);
  const found = match ? await ghRepo(match[1]!, match[2]!) : null;
  const value = found
    ? {
        canonical: `github.com/${found.fullName.toLowerCase()}`,
        owner: found.fullName.split("/")[0]!.toLowerCase(),
        avatarUrl: found.avatarUrl,
      }
    : null;
  repoCache.set(remote, { value, expiresAt: now + (value ? TTL_MS : FAILURE_TTL_MS) });
  return value;
}

/** Fetch the avatar on the daemon so the app needs no network access to GitHub's image CDN. */
async function avatarDataUri(owner: string, url: string): Promise<string | null> {
  const now = Date.now();
  const hit = avatarCache.get(owner);
  if (hit && hit.expiresAt > now) return hit.value;
  let value: string | null = null;
  try {
    const sized = new URL(url);
    sized.searchParams.set("s", String(AVATAR_SIZE));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    const response = await fetch(sized, { signal: abort.signal }).finally(() => clearTimeout(timer));
    const type = response.headers.get("content-type") ?? "image/png";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.ok && type.startsWith("image/") && bytes.length <= AVATAR_MAX_BYTES) {
      value = `data:${type};base64,${bytes.toString("base64")}`;
    }
  } catch {
    value = null;
  }
  avatarCache.set(owner, { value, expiresAt: now + (value ? TTL_MS : FAILURE_TTL_MS) });
  return value;
}

export async function resolveRepos({ remotes }: RpcInput<typeof resolveGithubRepos>) {
  const unique = [...new Set(remotes.map((remote) => remote.toLowerCase()))];
  const infos = await Promise.all(unique.map(async (remote) => [remote, await resolveRepo(remote)] as const));
  const canonical: Record<string, string> = {};
  const avatarUrls = new Map<string, string>();
  for (const [remote, info] of infos) {
    if (!info) continue;
    canonical[remote] = info.canonical;
    if (info.avatarUrl) avatarUrls.set(info.owner, info.avatarUrl);
  }
  const avatars: Record<string, string> = {};
  await Promise.all(
    [...avatarUrls].map(async ([owner, url]) => {
      const uri = await avatarDataUri(owner, url);
      if (uri) avatars[owner] = uri;
    }),
  );
  return { canonical, avatars };
}
