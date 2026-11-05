// Stores a JSON document in a (private) GitHub repo via the contents API.
// Needs a fine-grained token with "Contents: read and write" on that one repo.

const API = "https://api.github.com";

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubStore {
  constructor({ repo, token, path = "profile.json" }) {
    this.repo = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    this.token = token.trim();
    this.path = path;
    this.sha = null; // sha of the file version we last saw; required by GitHub to update
  }

  /** Read-only fetch of a file's parsed JSON (works for files over 1 MB too). Null if missing. */
  async loadRaw() {
    const res = await this.request("GET", undefined, "application/vnd.github.raw+json");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errorText(res));
    return res.json();
  }

  async request(method, body, accept = "application/vnd.github+json") {
    const res = await fetch(`${API}/repos/${this.repo}/contents/${this.path}`, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    return res;
  }

  /** Returns the stored document, or null if the file doesn't exist yet. */
  async load() {
    const res = await this.request("GET");
    if (res.status === 404) {
      // file missing is fine; a missing repo / no access is not
      const repoRes = await fetch(`${API}/repos/${this.repo}`, { headers: { Authorization: `Bearer ${this.token}` } });
      if (!repoRes.ok) throw new Error(`Repo "${this.repo}" not found or token has no access`);
      this.sha = null;
      return null;
    }
    if (!res.ok) throw new Error(await errorText(res));
    const file = await res.json();
    this.sha = file.sha;
    return JSON.parse(fromBase64(file.content));
  }

  async save(doc, message = "Update profile") {
    const put = () =>
      this.request("PUT", {
        message,
        content: toBase64(JSON.stringify(doc, null, 2) + "\n"),
        ...(this.sha ? { sha: this.sha } : {}),
      });
    let res = await put();
    if (res.status === 409 || res.status === 422) {
      // changed on another device since we loaded: take its sha, our version wins
      await this.load();
      res = await put();
    }
    if (!res.ok) throw new Error(await errorText(res));
    this.sha = (await res.json()).content.sha;
  }
}

async function errorText(res) {
  if (res.status === 401) return "Token invalid or expired";
  let message = "";
  try {
    message = (await res.json()).message ?? "";
  } catch {
    // no JSON body
  }
  if (res.status === 403 && /not accessible/i.test(message)) {
    return "Token can read but not write: set Contents to “Read and write”";
  }
  return message ? `GitHub (${res.status}): ${message}` : `GitHub error ${res.status}`;
}
