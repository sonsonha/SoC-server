# Railway production maintenance (no tsx)

Production image runs `npm ci --omit=dev`, so `tsx` is unavailable.
Maintenance CLIs are compiled by `npm run build` into `dist/scripts/` and
`dist/infrastructure/db/migrate.js`. Package scripts invoke `node`, not `tsx`.

After redeploy, in Railway console:

```bash
npm run db:migrate
npm run calendar:verify-schema
PERSONAL_OS_INITIAL_OWNER_EMAIL=you@example.com npm run calendar:backfill-owner
npm run calendar:enforce-ownership-not-null
```

Release hook already runs: `node dist/infrastructure/db/migrate.js`
