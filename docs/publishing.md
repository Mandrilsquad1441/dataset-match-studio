# GitHub publishing checklist

The repository has an MIT license but no remote or initial commit. No public GitHub repository has been created from this workspace. Choose the GitHub repository owner before publishing.

## 1. Set the public reuse terms

This project selected MIT for simple, broad reuse. Confirm that every contributor owns or can license the code they contributed before publishing.

## 2. Review the public contents

- Use a general name such as `dataset-match-studio` and remove account-, employer-, customer-, and project-specific values from checked-in files.
- Keep `.env.local`, `.dev.vars`, `.dev.vars.*`, Wrangler state, local Supabase state, generated review screenshots, and generated stress-run outputs ignored.
- Commit only synthetic examples. Inspect fixtures and screenshots manually for names, identifiers, and copied customer data.
- Check that the Supabase project reference, Cloudflare account ID, Trigger project reference, production URLs, and service credentials are absent.
- Enable GitHub private vulnerability reporting and any available secret-scanning / push-protection settings.
- Confirm the MIT license and contributor/security guidance are included, and verify the README install path from a clean clone.

The `.env.example` file contains placeholders only. Copy it to `.env.local` for local setup and never commit the local copy. Git ignore rules do not remove secrets that were already tracked; inspect staged files before publishing.

## 3. Publish from a new empty GitHub repository

Create an empty public repository on GitHub under the account or organization that should own it. Do not initialize it with a README, license, or gitignore; this workspace already contains those project files. After adding the chosen `LICENSE`, run from the project root:

```sh
git status --short
git check-ignore .env.local .dev.vars
git add .
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Inspect the staged diff and stop if it contains local secrets, account identifiers, private datasets, or generated results. Then set the new remote and publish the first commit:

```sh
git branch -M main
git remote add origin https://github.com/OWNER/dataset-match-studio.git
git commit -m "Prepare Match Studio for public release"
git push -u origin main
```

Replace `OWNER` with the intended GitHub user or organization. If `origin` already exists, inspect it with `git remote -v` before changing it.

## 4. After the first push

- Add a short repository description, topics for dataset matching / record linkage, and a README screenshot made only with synthetic data.
- Enable Issues and Discussions only if someone will maintain them; pin a small roadmap and document known limits.
- Add CI for install, type checking, tests, and build after checking GitHub Actions minutes and policy for the chosen account. The local test suite does not need provider keys.
- Use GitHub Releases for tagged versions and keep a short changelog for behavior or schema changes.
- Do not publish a hosted demo with shared credentials as a shortcut. A public `workers.dev` deployment needs access control, quotas, and budget monitoring before broad use.

## Local commands for collaborators

The browser-only matcher and the local fixture suite need no secrets:

```sh
npm ci
npm run dev
npm run test
npm run build
npm run evaluate
```

Optional integrations and bring-your-own-key setup are documented in [self-hosting](self-hosting.md). Default configuration does not make provider requests. External model inference requires both a user's own provider key and an explicit `ALLOW_PAID_MODEL_CALLS=true`; managed services can still bill when separately enabled.
