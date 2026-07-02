# Comments Worker — Cloudflare setup

This Worker lets `index.html` accept new comments without giving the browser
any write access to GitHub. It holds a GitHub token as a server-side secret,
checks the submitted password the same way the site itself does, and — only
if that's correct — appends the (encrypted) comment to `comments.json` in
this repo.

## 1. Create the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) and sign up or log in (free plan — no card required). This does **not** require moving your domain's DNS to Cloudflare.
2. In the sidebar, open **Workers & Pages**.
3. Click **Create** → **Create Worker**.
4. Give it a name, e.g. `vides-blogg-comments` (this becomes part of the URL: `https://vides-blogg-comments.<your-subdomain>.workers.dev`).
5. Click **Deploy** to create it with the default placeholder code.
6. Click **Edit code**, delete everything in the editor, and paste in the full contents of [`comments-worker.js`](./comments-worker.js) from this folder.
7. Click **Save and deploy**.

## 2. Add the GitHub token as a secret

The Worker needs its own GitHub token — **don't reuse** the one saved in `admin/index.html`'s settings panel, so you can revoke one without affecting the other.

1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta) → **Generate new token**.
2. Repository access: **Only select repositories** → `Videsblogg.github.io`.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Generate it and copy the value (starts with `github_pat_...`).
5. Back in the Cloudflare Worker's page, go to **Settings** → **Variables and Secrets**.
6. Add a variable named exactly `GITHUB_TOKEN`, paste the token as its value, and mark it as **Secret** (encrypted) rather than plain text.
7. Save — this may trigger a redeploy, which is fine.

## 3. Get the Worker's URL and wire it in

1. On the Worker's main dashboard page, copy the URL shown near the top (e.g. `https://vides-blogg-comments.yourname.workers.dev`).
2. In `index.html`, replace the placeholder:
   ```js
   const COMMENTS_WORKER_URL = 'https://REPLACE-ME.workers.dev';
   ```
   with your real Worker URL, then commit and push (or send me the URL and I'll do it).

## Notes

- CORS is locked to `https://www.videsblogg.se` in the script's `ALLOWED_ORIGIN` constant — if the domain ever changes, update it there too.
- `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_BRANCH` are hardcoded at the top of the script rather than made into variables, since they're not secret and specific to this one blog.
- The free Cloudflare Workers plan (100,000 requests/day) is far more than a personal blog will ever use — expect $0 cost.
