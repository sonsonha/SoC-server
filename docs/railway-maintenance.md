# Railway production maintenance (no tsx)

Production image runs `npm ci --omit=dev`, so `tsx` is unavailable.
Maintenance CLIs are compiled by `npm run build` into `dist/scripts/` and
`dist/infrastructure/db/migrate.js`. Package scripts invoke `node`, not `tsx`.

After redeploy, in Railway console:

```bash
npm run db:migrate
npm run calendar:verify-schema
npm run ai:verify-schema
PERSONAL_OS_INITIAL_OWNER_EMAIL=you@example.com npm run calendar:backfill-owner
npm run calendar:enforce-ownership-not-null
```

Release hook already runs: `node dist/infrastructure/db/migrate.js`

## AI Goal Structuring (DeepSeek Platform)

Canonical production provider: **DeepSeek** (`https://api.deepseek.com`).

Set these on **Railway only** (never Vercel `NEXT_PUBLIC_*`):

| Variable | Value |
|----------|--------|
| `LLM_PROVIDER` | `deepseek` |
| `DEEPSEEK_API_KEY` | from platform.deepseek.com |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` |

Vercel only proxies `/api/ai/*` to Railway and does **not** need the DeepSeek key.

Migration `0023_ai_user_context` adds `users.ai_context` (per-user, isolated).
Confirm with `npm run ai:verify-schema` after migrate.

Optional one-shot smoke (not CI):

```bash
DEEPSEEK_API_KEY=... npm run ai:smoke-goal-structure
```

## Database on Neon

Production Postgres lives on Neon. Railway only runs the API container.

1. Create a Neon project (same region as Railway, e.g. `aws-ap-southeast-1`).
2. Copy the **direct** connection string (host without `-pooler`). The pooled
   endpoint also works: the client turns off prepared statements for `-pooler` hosts.
3. Move existing data from Railway Postgres (run locally; client tools must be the same or newer major version than both servers):

   ```bash
   pg_dump --format=custom --no-owner --no-acl "$OLD_RAILWAY_DATABASE_URL" -f secretary.dump
   pg_restore --no-owner --no-acl --dbname "$NEON_DATABASE_URL" secretary.dump
   ```

   The dump includes the `drizzle.__drizzle_migrations` table, so the release
   hook does not re-run old migrations.
4. On Railway, set `DATABASE_URL` to the Neon URL and redeploy. The release hook
   runs pending migrations against Neon.
5. Check `/health`, then remove the old Railway Postgres service.

`channel_binding=require` in the Neon URL is stripped automatically; SSL is
forced for `*.neon.tech` hosts.
