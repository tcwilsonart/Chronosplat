The player is a static site. Anything that serves files over HTTP can host it.

## GitHub Pages

Viewer and sequence data live in the same repository and are served from the
same origin, so no CORS configuration is needed anywhere.

### One-time setup

1. Create a **public** repository and push the project.
2. **Settings → Pages → Source: GitHub Actions.**

That is all. `.github/workflows/deploy.yml` handles the rest.

### Publishing

```
git add data
git commit -m "Add capyFall sequence"
git push
```

The workflow builds the player, copies `data/` in beside it, checks the total
size, and deploys. The site appears at `https://<user>.github.io/<repo>/`.

`data/` is committed. `raw_data/` is not — source PLY frames are large and are
not needed to run the site.

Commit sequence data with git, not the web upload interface, which has a small
file-size cap.

## Limits

| Limit | Value |
|---|---|
| Published site | ~1 GB |
| Single file | 100 MB |
| Bandwidth | ~100 GB/month (soft) |

The site limit applies to **everything published together**, not to one
sequence. Individual `.sog` frames are far below the per-file limit, so the
total is the constraint that matters.

The converter reports the running total after every run:

```
  library (3 sequences):
      bogdanFly               235.0 MiB  31 frames
      capyFall                330.3 MiB  60 frames
      excavator               215.0 MiB  30 frames
      TOTAL                   780.3 MiB

  GitHub Pages         : 173.4 MiB headroom (82% of the ~1 GB ceiling used)
```

The deploy workflow checks the same total and **fails the build** rather than
publishing a site that would be truncated.

If you are over the limit, re-convert at smaller settings — see
[Converting PLY to SOG](Converting-PLY-to-SOG#reducing-size).

Avoid Git LFS. GitHub Pages has historically not served LFS objects directly,
so it tends to produce a site that builds but does not work.

## Repository size

Sequence data is committed, so it becomes part of the repository history
permanently — including versions you later replace. Some things that help:

- Settle on conversion settings **before** committing a sequence. Compare
  variants locally first.
- Prefer replacing a sequence in a single commit over many incremental
  re-conversions.
- Keep `raw_data/` out of the repository. It is already ignored.

If a sequence is still being iterated on, consider leaving it uncommitted until
it is final.

## Other static hosts

Any static host works. Build:

```
npm run build
```

Then copy `data/` into `dist/` and upload the result. The bundle uses relative
paths, so the same output works at a domain root or in a subdirectory without
rebuilding.

Requirements for a host:

- Serves files over HTTP with correct content types
- Supports **range requests** — frames are multi-megabyte binaries
- Serves the player and `data/` from the **same origin**, or sets CORS to allow
  `GET`, permit the `Range` request header, and expose `Content-Length`,
  `Content-Range` and `Accept-Ranges`

Do not gzip `.sog` files. They are already compressed.

### Serving data from a different origin

Set `baseUrl` in each `manifest.json` to the origin serving the frames:

```json
"baseUrl": "https://cdn.example.com/sequences/excavator/"
```

An empty `baseUrl` — the default — resolves frames relative to the manifest,
which is what keeps everything same-origin.

## Object storage for large libraries

Committing frames to the repository is the simplest setup, but the repository
keeps every version you ever commit. Re-converting a sequence adds its full
size again rather than a diff, because `.sog` files are already compressed and
Git cannot delta them.

Moving heavy sequences to object storage keeps the repository small and lifts
the 1 GB published-site ceiling, at the cost of a second place to deploy to.
Manifests stay in the repository either way, so cameras, backgrounds and the
sequence list remain version-controlled.

Set where a sequence's frames come from:

```
py tools/set_host.py capyFall --url https://data.example.com/capyFall/
```
```
py tools/set_host.py capyFall --local
```
```
py tools/set_host.py --list
```

Then rebuild the index so the size report reflects the change:

```
py tools/index_sequences.py --data ./data
```

Sequences on object storage are listed but excluded from the Pages ceiling,
since they are never part of the published site.

Finally, exclude their frames from the repository. `.gitignore` ignores
`data/*/frame_*.sog` and allows sequences back in individually:

```
data/*/frame_*.sog
!data/bogdanFly/frame_*.sog
```

### Cloudflare R2

R2 charges nothing for egress, which suits a splat library — the frames are
large and every viewer downloads them.

1. Create a bucket, then enable a public URL for it: either **Settings →
   Public Development URL**, or connect a custom domain.
2. Upload the frames. `rclone` handles the whole folder:

```
rclone copy ./data/capyFall r2:<bucket>/capyFall --header-upload "Cache-Control: public, max-age=31536000, immutable" --progress
```

The `Cache-Control` header is not optional in practice. R2 sends none by
default, so browsers fall back to heuristic freshness — a fraction of the
file's age — and re-request frames every few minutes. Since the player evicts
frames from memory as it plays, a looping sequence then re-downloads most of
itself on every lap.

Frame files are safe to mark `immutable`: their contents only change when you
deliberately re-convert and re-upload. `immutable` stops revalidation
altogether rather than merely extending freshness.

To fix headers on frames **already uploaded**, add `--ignore-times`. By default
rclone skips files whose size and timestamp match, so without it the command
completes instantly having changed nothing:

```
rclone copy ./data/capyFall r2:<bucket>/capyFall --header-upload "Cache-Control: public, max-age=31536000, immutable" --ignore-times --progress
```

Uploading to R2 is free, so re-sending is only a matter of time spent.

3. Add a CORS policy. Frames are fetched cross-origin, so without one the
   browser blocks every request. The policy is in
   [`tools/r2-cors.json`](../blob/main/tools/r2-cors.json) — edit the origins
   to match your site, then apply it either way:

**Dashboard.** R2 → your bucket → **Settings** → **CORS Policy** → **Add CORS
policy** → **JSON** tab, and paste the file.

**Wrangler.**

```
npx wrangler r2 bucket cors set <bucket> --file tools/r2-cors.json
```
```
npx wrangler r2 bucket cors list <bucket>
```

Changes usually apply immediately but can take up to 30 seconds.

### What the policy says, and why

```json
"AllowedOrigins": ["https://<user>.github.io", "http://localhost:5173"]
```

An origin is scheme, host and port only — **never a path**. Writing
`https://<user>.github.io/<repo>` is the most common mistake here and silently
matches nothing. Project sites share one origin, so the bare hostname is
correct even though the site lives in a subdirectory. The `localhost` entries
let `npm run dev` load hosted sequences; drop them if you would rather dev
only ever read local files.

```json
"AllowedMethods": ["GET", "HEAD"]
```

The player only ever reads. There is no reason to allow `PUT` or `DELETE` on a
public bucket.

```json
"AllowedHeaders": ["Range", "If-Match", "If-None-Match"]
```

`Range` permits partial reads of a frame. The conditional headers let the
browser revalidate a cached frame instead of re-downloading it.

```json
"ExposeHeaders": ["Content-Length", "Content-Range", "Content-Type",
                  "Accept-Ranges", "ETag"]
```

The one people miss. By default a cross-origin response hides every header
except a short safelist, so the page can see the bytes but not their length.
The result is a frame that downloads successfully and then fails to decode —
which looks like a corrupt file rather than a CORS problem, and sends you
looking in the wrong place.

`MaxAgeSeconds` caches the preflight result so the browser is not re-asking
before every frame.

### Checking it worked

Open the player and switch to a hosted sequence with the network panel open.
The `.sog` requests should go to the bucket's domain, return `200`, and carry
`access-control-allow-origin`. A CORS failure shows in the console rather than
in the response, so the network panel alone can look fine.

## Local preview of a build

```
npm run build
npm run preview
```

`preview` serves `dist/` only, so copy `data/` into `dist/` first or sequences
will be missing. For day-to-day work use `npm run dev`.

## Updating this wiki

Wiki pages are written in `wiki/` in the main repository and pushed to the
wiki's own repository:

```
git clone https://github.com/<user>/<repo>.wiki.git
cp wiki/*.md <repo>.wiki/
cd <repo>.wiki && git add . && git commit -m "Update docs" && git push
```

Page filenames map to titles: `Player-Usage.md` becomes *Player Usage*.
`_Sidebar.md` is the navigation panel.
