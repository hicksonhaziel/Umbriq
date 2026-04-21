<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Monorepo Note

Shared code can live in the repo root `packages/` folder (for example `types` and `solana`).
UI components for `apps/web` are currently app-local in `src/components/ui` (shadcn/ui setup).

## Routing Note

Keep production waitlist on `/`.
Build in-progress product work under `/dev` until it is ready to promote.
