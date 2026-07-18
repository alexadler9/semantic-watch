# Security notes

Stage 1 intentionally supports only public text pages without authentication.

Implemented controls:

- Telegram allowlist and optional one-time activation key;
- constant-time comparison for activation keys of equal length;
- watch ownership checks for list and stop operations;
- active-watch quota per user;
- HTTP/HTTPS-only URL policy;
- private and non-routable address blocking;
- redirect revalidation;
- request timeout, response-size and content-type limits;
- no cookies, credentials or authorization headers;
- exact local URL exception only when demo mode is enabled;
- secrets loaded from environment variables.

Not supported in the MVP:

- authenticated pages;
- browser automation;
- user-provided cookies or headers;
- JavaScript-rendered pages;
- PDF and image content;
- access to private networks.
