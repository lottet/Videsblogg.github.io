# Vides Blogg

A private, password-protected blog hosted on GitHub Pages, with no server or database — just static HTML and the GitHub API.

Live at: https://www.videsblogg.se

## How it works

- **`index.html`** — the reader page. Fetches `posts.json`, decrypts the posts with a key derived from the site password, and displays them with a year/month archive sidebar.
- **`admin/index.html`** — the editor, at `/admin/`. Writes new/edited/deleted posts straight to `posts.json` in this repo via the GitHub Contents API, using a personal access token you provide.
- **`posts.json`** — the data file. Titles and bodies are stored AES-GCM encrypted; only the salt, IV, and ciphertext are readable if someone fetches the file directly.
- **`images/`** — post images, uploaded as individual files (not encrypted, not inlined in `posts.json`) to stay under the GitHub API's ~1MB payload limit per file.
- **`CNAME`** — custom domain config for GitHub Pages (`www.videsblogg.se`).

## The password

There is one shared password for both reading and publishing — it's never stored anywhere, only used to derive an encryption key (PBKDF2 → AES-GCM). Correctness is checked by whether that key successfully decrypts a stored "check" value in `posts.json`, not by comparing strings. This means:

- The password isn't visible anywhere in the source code.
- **There's no "change password" feature yet.** Whoever knows the current password can read/write everything; rotating it would require decrypting all posts with the old key and re-encrypting with a new one.

## Publishing a post

1. Go to `/admin/` and enter the site password.
2. The first time on a given browser, click the ⚙ gear (top-right) and fill in:
   - GitHub username (repo owner)
   - Repository name
   - Branch (`main`)
   - A GitHub personal access token with **Contents: Read and write** on this repo only
3. These are saved in that browser's `localStorage` — no need to re-enter them on future visits from the same device/browser.
4. Write the post, optionally attach images and set a custom date, then hit **Publicera**. This commits directly to the repo, so the live site updates within a minute or two once GitHub Pages rebuilds.

## Known limitations

- Images are not encrypted (only titles/bodies are).
- No password-rotation flow.
- Deleting a post doesn't clean up its uploaded image files — they stay in `images/`.
- The GitHub token lives in browser `localStorage` in plaintext; treat any device you save it on as trusted.
