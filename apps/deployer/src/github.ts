import { readFileSync } from 'node:fs';

export type CheckState = 'pending' | 'success' | 'failure' | 'none';

export interface Commit {
  sha: string;
  message: string; // first line only
  /** Committer date, ISO. The CI-wait clock runs from here. */
  date: string;
  author: string;
}

export type GitHubErrorKind = 'unreachable' | 'auth' | 'rate' | 'other';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly status?: number,
    /** Rate-limit errors: when GitHub accepts requests again. */
    readonly resetAt?: Date,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** A request answered from an ETag: `changed: false` is a 304 (free against the rate limit). */
export type Conditional<T> = { changed: false } | { changed: true; data: T; etag?: string };

interface ApiCommit {
  sha: string;
  commit: { message: string; author?: { name?: string }; committer: { date: string } };
}

interface ApiRun {
  name: string;
  run_number?: number;
  created_at?: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

const API_TIMEOUT_MS = 30_000;

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

function toCommit(c: ApiCommit): Commit {
  return {
    sha: c.sha,
    message: c.commit.message.split('\n')[0] ?? '',
    date: c.commit.committer.date,
    author: c.commit.author?.name ?? '',
  };
}

/** Read-only GitHub client. The token (read from `tokenFile` per request) only ever goes in the Authorization header. */
export class GitHub {
  constructor(
    private readonly repo: string,
    private readonly tokenFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The token; a missing or empty file is an auth error, never a silent unauthenticated request. */
  private token(): string {
    let token: string | undefined;
    try {
      token = readFileSync(this.tokenFile, 'utf8').trim() || undefined;
    } catch {
      token = undefined;
    }
    if (!token) throw new GitHubError('GitHub token missing', 'auth');
    return token;
  }

  private async request(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const token = this.token();
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'skali-deployer',
          ...headers,
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      // The underlying error is dropped on purpose: it may echo request details.
      throw new GitHubError("Can't reach GitHub", 'unreachable');
    }
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : undefined;
      throw new GitHubError('GitHub rate limit reached; trying again later', 'rate', res.status, resetAt);
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitHubError('GitHub token expired or revoked', 'auth', res.status);
    }
    return res;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}`, 'other', res.status);
    return (await res.json()) as T;
  }

  /** The head commit of `branch`, as a conditional request: a 304 answers `changed: false`. */
  async headConditional(branch: string, etag?: string): Promise<Conditional<Commit>> {
    const res = await this.request(`/commits/${encodeURIComponent(branch)}`, etag ? { 'If-None-Match': etag } : {});
    if (res.status === 304) return { changed: false };
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status}`, 'other', res.status);
    const data = toCommit((await res.json()) as ApiCommit);
    const next = res.headers.get('etag');
    return next ? { changed: true, data, etag: next } : { changed: true, data };
  }

  /** Commits on `branch` after `sinceSha`, newest first. Without `sinceSha`: just the head. */
  async commitsSince(branch: string, sinceSha?: string): Promise<Commit[]> {
    if (sinceSha === undefined) {
      const list = await this.get<ApiCommit[]>(`/commits?sha=${encodeURIComponent(branch)}&per_page=1`);
      return list.slice(0, 1).map(toCommit);
    }
    const res = await this.get<{ commits: ApiCommit[] }>(`/compare/${sinceSha}...${encodeURIComponent(branch)}`);
    return res.commits.map(toCommit).reverse();
  }

  /**
   * State of the workflow named exactly `workflowName` for a commit, plus a run URL (the run that decided the state,
   * else the first). Other workflows (CodeQL, ...) never count. Uses Actions: Read, not the Checks API.
   */
  async ciState(sha: string, workflowName: string): Promise<{ state: CheckState; runUrl?: string }> {
    const res = await this.get<{ workflow_runs: ApiRun[] }>(`/actions/runs?head_sha=${sha}&per_page=100`);
    const runs = res.workflow_runs.filter((r) => r.name === workflowName);
    if (runs.length === 0) return { state: 'none' };
    // Decide on the newest run (a re-run supersedes an older red or green); don't rely on API order.
    const newest = runs.reduce((a, b) =>
      (b.run_number ?? 0) !== (a.run_number ?? 0)
        ? (b.run_number ?? 0) > (a.run_number ?? 0) ? b : a
        : (b.created_at ?? '') > (a.created_at ?? '') ? b : a,
    );
    if (newest.status !== 'completed') return { state: 'pending', runUrl: newest.html_url };
    if (!newest.conclusion || !OK_CONCLUSIONS.has(newest.conclusion)) return { state: 'failure', runUrl: newest.html_url };
    return { state: 'success', runUrl: newest.html_url };
  }
}
