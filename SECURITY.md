# Security policy

## Supported versions

Security fixes target the latest code on the default branch. There are no release branches or guaranteed support windows yet.

## Report a vulnerability

Please use GitHub's private vulnerability reporting or create a private security advisory for this repository. Do not publish exploit details or attach real datasets in a public issue. If private reporting is not enabled, contact the repository owner privately through their GitHub profile and request a secure channel.

Include the affected file or feature, impact, and concise reproduction steps. Do not include live credentials or personal records.

## Credential handling

- Keep `.env.local`, `.dev.vars`, service-role keys, Trigger keys, and provider keys out of Git.
- Browser-exposed variables must never contain server credentials. Only the Supabase anon key is designed to be public, and it still relies on correct row-level security.
- Local/provider inference is disabled by default. Enabling it sends selected record fields to the chosen provider and may incur charges.
- If a key is committed or pasted into a public issue, revoke it at its provider and create a replacement. Removing it from a later commit does not erase it from Git history.

## Data handling

Use synthetic data for examples, issues, screenshots, fixtures, and benchmark labels. Review the architecture guide's [service boundaries](docs/matching-architecture.md#service-boundaries) and [cost controls](docs/matching-architecture.md#default-cost-controls-and-bring-your-own-key) before enabling hosted services or external inference.
