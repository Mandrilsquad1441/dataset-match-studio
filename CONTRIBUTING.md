# Contributing

Thanks for helping improve Match Studio. Keep changes focused, explain user-visible behavior, and include synthetic examples for data-handling changes.

## Before opening an issue or pull request

- Search existing issues and discussions for the same problem.
- Never attach real customer, personal, regulated, or confidential datasets. Use generated examples.
- Do not include API keys, database dumps, logs containing user records, screenshots of private data, or `.env` files.
- For a security issue, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Local workflow

Use Node.js 22 or later:

```sh
npm ci
npm run dev
```

The local matcher works without cloud accounts or API keys. Before submitting, run:

```sh
npm run test
npm run build
npm run evaluate
```

Database tests require Docker and the Supabase CLI. Cloud-provider checks require accounts and may incur charges; do not run them unless you intentionally configure your own credentials and accept that usage.

## Change guidelines

- Preserve the browser-only, zero-key path.
- Keep provider calls behind the explicit paid-call opt-in and server-side credentials.
- Add or update tests for parser, scoring, policy, and API changes.
- Use synthetic records and deterministic fixtures; state clearly when a result is only a small benchmark.
- Update the relevant architecture, setup, or security documentation when a boundary or requirement changes.
- Avoid adding dependencies for functionality already available in the platform or current stack.

## Pull requests

Describe the problem, the approach, and any behavior or migration impact. Include the commands you ran and their outcomes. For UI changes, include a screenshot with synthetic data only.
