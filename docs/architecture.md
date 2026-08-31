# Architecture

The plugin has four deliberately separate boundaries:

1. Discovery reads published Markdown and creates a local manifest.
2. A transport synchronizes immutable objects through either the Worker API or R2's S3-compatible API.
3. A Quartz transformer rewrites the generated HAST only in remote mode.
4. Finalization and checks remove redundant output and fail closed when generated HTML is inconsistent.

Worker mode uses bindings rather than Cloudflare REST APIs. Original responses stream from R2, byte ranges remain intact, transformed images pass R2 streams directly into the Images binding, and cache writes use `ctx.waitUntil()`.

The manifest is not an external protocol. Worker routes accept only validated content-addressed keys and never receive source note paths.
