# Predex delivery rules

## Scope gate before delegation

Before dispatching work to an agent, state all five items below:

1. Necessity: the accepted requirement or verification obligation it completes.
2. Why now: why the active vertical slice cannot finish without it.
3. Minimum scope: the smallest sufficient change.
4. Non-goals: adjacent work that is deliberately excluded.
5. Exit test: objective evidence that ends the task.

Dispatch only work that directly completes the accepted slice, verifies it, or removes a demonstrated correctness, security, or delivery blocker. Defer speculative scaling, reusable frameworks, unrelated cleanup, and optional integrations. Agents may not expand their own scope; newly discovered work returns to the root and must pass this gate.

## Source and verification

- Edit source only on the Mac.
- Run installs, builds, tests, and runtime QA on CloudLab through `scripts/cloudlab/`.
- Never sync `.git`, secrets, dependency directories, build output, or QA caches to CloudLab.
- CloudLab source mirrors are disposable and must never be edited or synced back over local source.
- Record the source ID with every verification result.

## Git flow

- Start feature branches and worktrees from `dev`.
- Do not commit directly to `dev` or `main`.
- When a feature is complete, independently verified, and reviewed, merge it into local `dev`.
- Verify the exact merged `dev` tree on CloudLab before pushing `dev` to origin.
- Never force-push `dev` or `main`.

## Product direction

- Adapt the accepted Codex Terminal design to the existing Next.js application.
- Keep MetaMask as the primary wallet. Privy and World remain optional paths.
- Ship the responsive web app and installable PWA before considering Capacitor.
- Preserve the existing desktop product where possible; mobile is the primary design gap.
