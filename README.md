# Quartz Cloudflare Media

Production-ready R2 and Cloudflare Images delivery for Quartz 5. Your Obsidian vault and Git repository stay the source of truth; production builds upload only referenced media, rewrite generated HTML to immutable Cloudflare URLs, and remove redundant copies from the site artifact.

## Quick start

From an existing Quartz 5 site:

```bash
npx @alexchenh/quartz-cloudflare-media init
```

The guided installer defaults to a private R2 bucket behind a small Worker. It verifies Wrangler authentication, provisions storage, deploys the Worker, installs the Quartz transformer, adds build scripts, copies Quartz publication exclusions, and runs local validation. Preview changes without writing anything:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alexchenh/quartz-cloudflare-media/tree/main/worker)

```bash
npx @alexchenh/quartz-cloudflare-media init --dry-run --backend worker
```

For unattended setup, provide non-secret values as flags:

```bash
npx @alexchenh/quartz-cloudflare-media init \
  --backend worker \
  --worker-name my-garden-media \
  --bucket my-garden-media \
  --pages-project my-garden \
  --yes
```

The upload secret is generated in memory and sent directly to Wrangler. It is never accepted as a CLI argument, printed, or written to the repository.

## How it works

```text
published Markdown + local media
             |
             | prepare + content hash
             v
       local manifest (private)
             |
             | upload missing immutable keys
             v
       Cloudflare R2 (private in Worker mode)
          |                         |
          | Images binding          | original/range response
          v                         v
 responsive AVIF/WebP/JPEG         video or full-size image
          \_________________________/
                       |
                       v
              generated Quartz HTML
```

The scanner understands Markdown images, Obsidian embeds, and HTML `img`, `video`, and `source` elements. It honors `.gitignore`, configured Quartz ignore patterns, and `draft: true`. Missing or ambiguous references fail the build instead of publishing the wrong file.

Object keys use `v1/<sha256>/<safe-filename>`. Changing bytes creates a new URL; unchanged objects are skipped. Automatic deletion is intentionally unavailable.

## Backends

### Worker (recommended)

Worker mode gives the simplest and safest setup:

- R2 stays private.
- The Worker serves originals, range-aware video, and Images-binding transformations.
- Upload, listing, and multipart routes require a generated bearer secret.
- `workers.dev` works without DNS; a custom domain can be added later.
- Large files are split below Cloudflare's request-body limit and uploaded through R2 multipart APIs.

Every media request invokes the Worker. Review current Workers, R2, and Images allowances before high-traffic use.

### Direct R2

Direct mode avoids Worker request usage and is useful for established R2 custom-domain deployments. It requires an R2 S3 token restricted to the target bucket:

```bash
npx @alexchenh/quartz-cloudflare-media init \
  --backend direct-r2 \
  --bucket my-garden-media \
  --origin https://media.example.com \
  --image-transform-origin https://media.example.com
```

Set these only in the build environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Connect the bucket to a custom domain, disable the public `r2.dev` hostname, enable Images transformations for the zone, cache the media hostname including video extensions, and scope any bot-management exception to that hostname only.

## Quartz configuration

The installer adds the plugin immediately after Crawl Links:

```yaml
plugins:
  - source: "@alexchenh/quartz-cloudflare-media"
    enabled: true
    order: 65
    options:
      backend: worker
      publicOrigin: https://my-garden-media.example.workers.dev
      contentDirectory: content
      outputDirectory: public
      cacheDirectory: .quartz-cache
      ignorePatterns:
        - private
        - templates
        - .obsidian
      excludeDrafts: true
      imageWidths: [640, 1280, 1920]
      defaultImageWidth: 1280
      imageQuality: 88
      imageSizes: "(max-width: 800px) 100vw, 800px"
```

Local builds remain unchanged. A remote media build uses:

```bash
npm run media:sync
CLOUDFLARE_MEDIA_MODE=remote npx quartz build
npm run media:finalize
npm run media:check
```

The installer adds this sequence as `npm run build:media`.

## CLI

| Command           | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `init`            | Install and configure an existing Quartz 5 site            |
| `doctor`          | Validate scripts, secrets, configuration, and media origin |
| `prepare`         | Discover published media and write the local manifest      |
| `sync`            | Upload only missing content-addressed objects              |
| `finalize`        | Remove redundant media from Quartz output                  |
| `check`           | Verify generated URLs and artifact removal                 |
| `deploy-worker`   | Provision or update the companion Worker and R2 bucket     |
| `configure-ci`    | Rotate and connect Worker and Pages upload secrets         |
| `prune --dry-run` | List unused objects without deleting them                  |
| `undo-init`       | Restore installer-owned files if they have not changed     |

Use `--root` when invoking the CLI outside the Quartz directory. `init` also supports `--dry-run`, `--yes`, `--json`, `--backend`, `--bucket`, `--worker-name`, `--pages-project`, and `--origin`.

## Operations and rollback

- Retry failed syncs safely; immutable keys make uploads idempotent.
- Run `doctor` after Quartz, Node, Cloudflare, or build-provider changes.
- Validate video seeking with a byte-range request.
- Review `prune --dry-run` manually. The package cannot delete stale production media.
- `undo-init` restores only files whose hashes still match the installer receipt. It never removes Workers, buckets, secrets, or R2 objects.
- To disable remote media immediately, remove `CLOUDFLARE_MEDIA_MODE=remote` from the build. Quartz will use local asset URLs again.

## Privacy and non-goals

Worker mode uploads object bytes, content type, and the content hash. Note paths and the manifest stay local. Anyone with a published media URL can retrieve that media; private content must remain under ignored paths.

Non-goals: Cloudflare Stream, video transcoding, adaptive bitrate, generated posters, browser uploads, replacing Obsidian assets, or automatic deletion.

## Development

```bash
npm install
npm --prefix worker install
npm --prefix worker run types
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT
