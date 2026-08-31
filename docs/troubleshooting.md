# Troubleshooting

## Manifest unavailable

Run `npm run media:sync` before a build with `CLOUDFLARE_MEDIA_MODE=remote`.

## Missing or ambiguous media

Use a note-relative or vault-root path. Basename-only resolution works only when exactly one case-insensitive basename exists in the published vault.

## Unauthorized Worker upload

Run `quartz-cloudflare-media configure-ci --worker-name <name> --pages-project <name>` to rotate and set the same generated secret on both services.

## Video does not seek

Check that the response is `206 Partial Content` and includes `Content-Range` and `Accept-Ranges: bytes`. Direct-R2 installations may also need a cache rule that covers the video extension.

## Images transformation fails

Confirm the Images binding is present and the requested width is listed in `IMAGE_WIDTHS`. Direct-R2 installations must allow the R2 custom domain as an Images source.

## Safe rollback

Remove remote mode from the build first. If installer-owned files remain unchanged, run `quartz-cloudflare-media undo-init`. Remote resources are intentionally retained.
