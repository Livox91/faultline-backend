# Authentication and authorization

Faultline has two roles, and one rule that matters:

```
Admin            → assigned projects, plus user management and the audit trail
Onsite Engineer  → assigned projects, with a smaller action set
```

**A project is a cluster.** The control plane already keys incidents, baselines and
telemetry by `cluster_id`, so making the cluster the unit of assignment means every
existing read path is authorized by a column its queries already carry. The API exposes
the same resource at `/projects` and `/clusters`: same rows, same rules.

## Where enforcement actually happens

Authorization is enforced in the API, not in React. The frontend hides what a user
cannot use, but that is a courtesy — deleting every guard in the React app would not
expose a single row.

Four layers, each independent:

| Layer | What it does | On failure |
|---|---|---|
| `AuthenticationGuard` (global) | Verifies the token, re-loads the user **and their current assignments** from PostgreSQL | `401` |
| `AuthorizationGuard` (global) | Checks `@Roles`, `@RequirePermission` and `@RequiresProjectAccess`; records every refusal | `403` |
| Query scoping | The caller's permitted cluster ids are passed **into** the SQL (`cluster_id = ANY($1)`), not filtered out of its result | empty result |
| `assertScopedCluster` | The telemetry store refuses any cluster outside the resolved scope before touching ClickHouse | `403` |

Both guards are registered with `APP_GUARD`, so **a new route is protected unless it is
explicitly marked `@Public()`**. Forgetting a decorator locks a door rather than opening
one. Only `/health`, `/health/ready` and `POST /auth/login` are public.

### Why assignments are re-read on every request

A session can be revoked while its signed token is still within its expiry. The token
therefore carries identity and session id only — `sub`, `email`, `role`, `jti` — and no
authorization decision reads the role claim. Granting or revoking a project, or disabling
an account, takes effect on the user's **very next request**, with the token they already
hold. There is nothing to wait out and no need to sign out.

### 403 or 404?

Deliberately different, because they say different things:

- **Project ids** are chosen by an Admin and often guessable, so naming one you cannot
  reach answers `403`. Hiding it would be theatre.
- **Incident ids** are UUIDs whose existence is itself information, so an incident in a
  project you are not assigned to answers `404` — the same as one that does not exist.

## Roles and permissions

`packages/auth/src/roles.ts` is the single definition; `src/auth/roles.js` in the
frontend mirrors it for display only.

| Permission | Admin | Onsite Engineer |
|---|:--:|:--:|
| `project:view` | ✅ *(assigned only)* | ✅ *(assigned only)* |
| `incident:view` | ✅ *(assigned only)* | ✅ *(assigned only)* |
| `remediation:act` | ✅ *(assigned only)* | ✅ *(assigned only)* |
| `project:create` / `edit` / `delete` | ✅ | ❌ |
| `project:assign` | ✅ | ❌ |
| `user:view` / `user:manage` | ✅ | ❌ |
| `audit:view` | ✅ | ❌ |
| `settings:manage` | ✅ | ❌ |

A *permission* answers "may this role ever?"; an *assignment* answers "may this user,
here?". They are separate checks, which is why an engineer holds `project:view` and still
sees only their own projects.

## Schema (migration `0010_rbac_and_audit.sql`)

```
users ──┬─< project_users >── clusters      (project_users is the many-to-many)
        └─< audit_log
```

- `users` — `role` is constrained to `admin` / `onsiteengineer`. `password_hash` is
  nullable, because a user whose identity comes from an external IdP has none.
  `external_subject` is the seam for that IdP.
- `project_users` — **the single source of truth** for every user's cluster access. There is no
  second place to grant it: no per-user flag, no per-project override. Its
  `environments text[]` column is the seam for environment-level access; empty means
  "every environment", so today's rows keep working when it starts being enforced.
- `clusters.environment` — advisory today, read by those checks when they land.
- `audit_log` — append-only **at the table**:

  ```sql
  CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
  CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
  ```

  Verified: `UPDATE audit_log SET action='tampered'` reports `UPDATE 0` even as the
  database owner. Dropping the trail is a migration, which is reviewable.

  Migration `0014_audit_integrity.sql` adds an HMAC-SHA-256 hash chain. Each new row
  signs its canonical contents plus the preceding hash while an advisory transaction
  lock serializes writers. The key stays in `AUDIT_INTEGRITY_KEY`, outside PostgreSQL.
  Rows predating the migration remain explicitly unsigned rather than receiving a
  misleading backfilled signature. A `NOT VALID` check constraint permits those legacy
  rows but requires complete integrity fields on every new row.

  This HMAC chain provides strong tamper evidence, not third-party legal
  non-repudiation: the service holding the shared key can also produce valid records.
  Deployments needing independent proof should sign retained head hashes with an
  asymmetric key held by a separate system or immutable ledger.

## Endpoints

### Public
| Method | Path | |
|---|---|---|
| `GET` | `/health`, `/health/ready` | liveness / readiness |
| `POST` | `/auth/login` | `{email, password}` → `{accessToken, expiresAt, user}` |

### Any authenticated user
| Method | Path | Scope |
|---|---|---|
| `GET` | `/auth/me` | own identity |
| `POST` | `/auth/logout` | records the event |
| `GET` | `/projects`, `/clusters` | assigned projects for every role |
| `GET` | `/projects/:id` | `403` unless assigned |
| `GET` | `/incidents` | bounded by assignment, whatever filter is sent |
| `GET` | `/incidents/:id` | `404` when outside your projects |
| `GET` | `/incidents/:id/evidence` | as above |
| `GET` | `/telemetry/*`, `/resources/:id/timeline`, `/baselines*` | `403` for a cluster outside scope |
| `GET` | `/system/info` | authenticated |

### Admin only
| Method | Path | |
|---|---|---|
| `POST` / `PATCH` / `DELETE` | `/projects[/:id]` | delete returns `409` while incidents reference it |
| `GET` / `POST` | `/admin/users` | list / create |
| `PATCH` | `/admin/users/:id` | name, role, status, password, MFA |
| `PUT` / `DELETE` | `/admin/users/:id/projects/:projectId` | assign / unassign |
| `GET` | `/admin/audit` | read-only; filter by `action`, `outcome`, `userId`, `since`, `until`, `limit` |
| `GET` | `/admin/audit/verify` | verifies signed records and reports unsigned legacy rows |

## Configuration

Added to `apps/api/.env` (see `.env.example`). `AUTH_JWT_SECRET` is **required** for the
API outside `NODE_ENV=test` — it refuses to start without it, because starting would mean
every request 500s.

| Variable | Default | Notes |
|---|---|---|
| `AUTH_JWT_SECRET` | — | ≥32 chars. Rotating it logs everyone out. |
| `AUTH_TOKEN_ISSUER` | `faultline` | `iss` claim, written and required |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | 60–86400 |
| `AUTH_MFA_REQUIRED` | `false` | See the MFA note below |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | — | Seeds the first Admin, only while `users` is empty |
| `AUTH_BOOTSTRAP_ADMIN_PASSWORD` | — | Both or neither; ≥12 chars |
| `AUDIT_INTEGRITY_KEY` | development-derived | ≥32 chars; required explicitly for the production API |
| `AUDIT_INTEGRITY_KEY_ID` | `primary` | Identifier stored with each signed record |
| `AUDIT_STRICT` | `false` | Rethrow audit write failures so the request reports failure |

Unset both bootstrap values once you have signed in — an env file is not a credential
store.

## Getting in

```bash
npm run db:migrate                 # applies 0010_rbac_and_audit
npm run faultline:start            # the bootstrap Admin is seeded on first start
```

Or create accounts directly, which also works when the last Admin password is lost:

```bash
npm run user:create   -- --email admin@you.io  --name "Admin" --role admin --password "at-least-12-chars"
npm run user:create   -- --email ahmed@you.io  --name "Ahmed" --role onsiteengineer --password "at-least-12-chars" --projects project-a,project-c
npm run user:assign   -- --email ahmed@you.io  --project project-a
npm run user:unassign -- --email ahmed@you.io  --project project-a
npm run user:role     -- --email ahmed@you.io  --role admin
npm run user:password -- --email ahmed@you.io  --password "..."
npm run user:disable  -- --email ahmed@you.io
npm run user:list
```

`user:role` and `user:disable` refuse to remove the last active Admin.

## Enterprise identity (SSO / OAuth / LDAP / MFA)

Not wired, but the shape is deliberate:

- Tokens are standard HS256 JWTs verified in one place (`packages/auth/src/tokens.ts`).
  Pointing at an external issuer means replacing `verifyAccessToken` with RS256
  verification against a JWKS; no caller changes, because nothing else parses a token.
- `users.external_subject` already exists for the IdP's `sub` claim, and
  `password_hash` is nullable for users who have no local credential.
- **MFA**: with `AUTH_MFA_REQUIRED=true` and a user who has `mfa_enabled`, login answers
  `503` rather than issuing a token. That is intentional — there is no MFA provider in
  this deployment, and a screen that accepts any six digits is worse than no screen. The
  frontend's `/mfa` page says so instead of pretending to verify.

## Session security

- Every JWT has a `jti` backed by a short-lived Redis session record. Logout deletes
  that record; password changes and `POST /admin/users/:id/revoke-sessions` delete every
  session for the account. Disabling an account or replacing its password does the same.
- Browsers use the `fl_session` cookie with `HttpOnly`, `SameSite=Strict`, path `/`, and
  `Secure` in production. Bearer tokens remain accepted for non-browser API clients.
- Login and password-change failures share Redis counters across API instances (8
  failures per identifier in 15 minutes). Authentication fails closed if Redis is down.

## Known limitations

1. **Audit strictness is configurable.** With `AUDIT_STRICT=true`, an audit write error
   is rethrown and the request fails. With it off, the error is logged and availability
   is preferred. Strict deployments should monitor and externally retain the head hash
   returned by `/admin/audit/verify`, which also makes deletion of the newest chain tail
   detectable outside the database.
2. **The API enables no CORS.** The frontend must be same-origin; in development Vite
   proxies `/api`. Serving it from another origin needs an explicit cookie/CORS policy.
3. **Environment-level access is modelled, not enforced.** `project_users.environments`
   and `clusters.environment` are read and written; no check consults them yet, and
   `hasEnvironmentAccess` already sits on the path for when one should.
4. **Passwords use Node's `scrypt`**, not argon2id — no native toolchain required, and
   the cost parameters are stored in each hash so they can be raised without
   invalidating existing passwords.
5. **`/system/info` is authenticated**, which is why the foundation boot test asserts
   `401` for it. That assertion is the end-to-end proof that the global guard is wired.

## Tests

```bash
npm test                    # 157 tests, including the suite below
npm run test:authorization  # 14 tests, authorization only
```

`tests/authorization.test.cjs` covers, with the real guards in front of the real
controllers: anonymous refusal on every route; forged, foreign-issued and expired tokens;
project isolation via listing, direct id and the `/clusters` alias; incident scoping by
assignment rather than by the caller's filter; every admin-only write refused for an
engineer; assignment grant and revoke taking effect on an existing token; a disabled
account losing access; an Admin being unable to demote or disable themselves; the audit
trail recording denials and permission changes; the assignment roster being hidden from
engineers; and scope intersection between the deployment scope and the caller's
assignments.
