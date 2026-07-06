# Comments + Admin Worker — Cloudflare setup

This Worker has two jobs, both proxying the GitHub Contents API with a
token that only ever lives as a server-side secret — the browser never
holds one:

1. Lets `index.html` accept new comments without any GitHub access, and
   read `posts.json`/`comments.json` live from GitHub's API instead of
   the static files GitHub Pages serves — so new posts and comments show
   up immediately instead of waiting on a Pages rebuild (which can lag
   behind a commit by anywhere from seconds to a couple of minutes).
2. Lets `admin/index.html` publish/edit/delete posts, upload images, and
   save the tagline — all authenticated with a plain username/password
   instead of a GitHub personal access token pasted into the browser.

## 1. Create the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up or log in (free plan — no card required). This does **not** require moving your domain's DNS to Cloudflare.
2. In the sidebar, open **Workers & Pages**.
3. Click **Create**, then **"Start with Hello World!"** (there's no plain "blank Worker" option anymore).
4. Give it a name, e.g. `vides-blogg-comments` (this becomes part of the URL: `https://<name>.<your-subdomain>.workers.dev`).
5. Click **Deploy** to create it with the default placeholder code.
6. Click **Edit code**, delete everything in the editor, and paste in the full contents of [`comments-worker.js`](./comments-worker.js) from this folder.
7. Click **Save and deploy**.

## 2. Add the secrets

Go to the Worker's **Settings** → **Variables and Secrets**, and add each of these as a **Secret** (encrypted), not plain text:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | A GitHub personal access token — see below |
| `ADMIN_USERNAME` | Whatever username you want to log into `/admin/` with |
| `ADMIN_PASSWORD` | Whatever password you want to log into `/admin/` with |

**Creating `GITHUB_TOKEN`:**
1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) → **Generate new token**.
2. Repository access: **Only select repositories** → `Videsblogg.github.io`.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Generate it and copy the value (starts with `github_pat_...`).

**`ADMIN_USERNAME`/`ADMIN_PASSWORD`:** these are not your GitHub credentials — pick anything. The password you choose here also becomes the key that encrypts/decrypts your posts and comments (same as before), so **use a real password you'll remember**, not a placeholder — there's no "change password" flow yet, so whatever you set the first time you log in after this change is permanent.

Save each — this may trigger a redeploy, which is fine.

## 3. Get the Worker's URL and wire it in

Both `index.html` (`WORKER_URL`) and `admin/index.html` (`ADMIN_WORKER_URL`) need the same Worker's URL, shown on the Worker's main dashboard page (e.g. `https://vides-blogg-comments.yourname.workers.dev/`). If you're setting this Worker up fresh, send me the URL and I'll wire both in.

## Notes

- CORS is locked to `https://www.videsblogg.se` in the script's `ALLOWED_ORIGIN` constant — if the domain ever changes, update it there too.
- `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_BRANCH` are hardcoded at the top of the script rather than made into variables, since they're not secret and specific to this one blog.
- The free Cloudflare Workers plan (100,000 requests/day) is far more than a personal blog will ever use — expect $0 cost.
- `admin/index.html` no longer has any settings UI at all — no repo/branch/token fields, just the username/password login. If you ever need to change the GitHub token, repo, or branch, that now happens by updating the Worker's secrets/code, not the admin page.
- Reading posts/comments now goes through GitHub's API (rate-limited, 5,000 requests/hour with a token) instead of GitHub Pages' unlimited static CDN. Fine for a personal blog's traffic; would need rethinking if this ever got heavy, unrelated traffic.
