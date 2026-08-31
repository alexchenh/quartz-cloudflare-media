# Security policy

Report vulnerabilities privately through GitHub Security Advisories. Do not open a public issue for a suspected credential leak or authentication bypass.

Only the latest major release receives security fixes. The plugin never needs Cloudflare global API keys. Worker mode uses a generated upload secret; direct-R2 mode should use an R2 token restricted to one bucket.
