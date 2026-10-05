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

| Layer                          | What it does                                                                                                            | On failure   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------ |
| `AuthenticationGuard` (global) | Verifies the token, re-loads the user **and their current assignments** from PostgreSQL                                 | `401`        |
| `AuthorizationGuard` (global)  | Checks `@Roles`, `@RequirePermission` and `@RequiresProjectAccess`; records every refusal                               | `403`        |
| Query scoping                  | The caller's permitted cluster ids are passed **into** the SQL (`cluster_id = ANY($1)`), not filtered out of its result | empty result |
| `assertScopedCluster`          | The telemetry store refuses any cluster outside the resolved scope before touching ClickHouse                           | `403`        |

Both guards are registered with `APP_GUARD`, so **a new route is protected unless it is
explicitly marked `@Public()`**. Forgetting a decorator locks a door rather than opening
one. Only `/health`, `/health/ready` and `POST /auth/login` are public.

### Why assignments are re-read on every request

A token is valid for its whole lifetime, but an assignment can be revoked a second after
it is issued. The token therefore carries identity only — `sub`, `email`, `role` — and no
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

| Permission                           |        Admin         |   Onsite Engineer    |
| ------------------------------------ | :------------------: | :------------------: |
| `project:view`                       | ✅ _(assigned only)_ | ✅ _(assigned only)_ |
| `incident:view`                      | ✅ _(assigned only)_ | ✅ _(assigned only)_ |
| `remediation:act`                    | ✅ _(assigned only)_ | ✅ _(assigned only)_ |
| `project:create` / `edit` / `delete` |          ✅          |          ❌          |
| `project:assign`                     |          ✅          |          ❌          |
| `user:view` / `user:manage`          |          ✅          |          ❌          |
| `audit:view`                         |          ✅          |          ❌          |
| `settings:manage`                    |          ✅          |          ❌          |

A _permission_ answers "may this role ever?"; an _assignment_ answers "may this user,
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
  Migration `0025` adds a database trigger requiring the target user, project, and
  assigning administrator to belong to the same organization.
- `clusters.environment` — advisory today, read by those checks when they land.
- `audit_log` — append-only **at the table**:

  ```sql
  CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
  CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;
  ```

  Verified: `UPDATE audit_log SET action='tampered'` reports `UPDATE 0` even as the
  database owner. Dropping the trail is a migration, which is reviewable.

The centralized trail records every security- or incident-relevant operator mutation
with the authenticated actor, target, outcome, client address, user agent, and safe
change metadata. This includes user creation and profile edits; role, status, password,
and MFA changes; project assignment changes; incident acknowledgements; and manual Slack
ticket requests. Incident acknowledgement also remains in the notification event trail,
where it participates in the operational incident timeline.

Migration `0021_audit_integrity.sql` adds an HMAC-SHA-256 hash chain. Each new row
signs its canonical contents and the preceding hash while an advisory transaction lock
serializes writers. `/admin/audit/verify` verifies the chain. This is tamper evidence;
deployments requiring third-party non-repudiation should externally sign retained head
hashes with an independently held asymmetric key.

## Endpoints

### Public

| Method | Path                       |                                                        |
| ------ | -------------------------- | ------------------------------------------------------ |
| `GET`  | `/health`, `/health/ready` | liveness / readiness                                   |
| `POST` | `/auth/login`              | `{email, password}` → `{accessToken, expiresAt, user}` |

### Any authenticated user

| Method | Path                                                     | Scope                                          |
| ------ | -------------------------------------------------------- | ---------------------------------------------- |
| `GET`  | `/auth/me`                                               | own identity                                   |
| `POST` | `/auth/logout`                                           | records the event                              |
| `GET`  | `/projects`, `/clusters`                                 | assigned projects for every role               |
| `GET`  | `/projects/:id`                                          | `403` unless assigned                          |
| `GET`  | `/incidents`                                             | bounded by assignment, whatever filter is sent |
| `GET`  | `/incidents/:id`                                         | `404` when outside your projects               |
| `GET`  | `/incidents/:id/evidence`                                | as above                                       |
| `GET`  | `/telemetry/*`, `/resources/:id/timeline`, `/baselines*` | `403` for a cluster outside scope              |
| `GET`  | `/system/info`                                           | authenticated                                  |

### Admin only

| Method                      | Path                                   |                                                                               |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `POST` / `PATCH` / `DELETE` | `/projects[/:id]`                      | delete returns `409` while incidents reference it                             |
| `GET` / `POST`              | `/admin/users`                         | list / create                                                                 |
| `PATCH`                     | `/admin/users/:id`                     | name, role, status, password, MFA                                             |
| `PUT` / `DELETE`            | `/admin/users/:id/projects/:projectId` | assign / unassign                                                             |
| `GET`                       | `/admin/audit`                         | read-only; filter by `action`, `outcome`, `userId`, `since`, `until`, `limit` |
| `GET`                       | `/admin/audit/verify`                  | verify the signed audit chain                                               |

## Configuration

Added to `apps/api/.env` (see `.env.example`). `AUTH_JWT_SECRET` is **required** for the
API outside `NODE_ENV=test` — it refuses to start without it, because starting would mean
every request 500s.

| Variable                          | Default     | Notes                                                                       |
| --------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `AUTH_JWT_SECRET`                 | —           | ≥32 chars. Rotating it logs everyone out.                                   |
| `AUTH_TOKEN_ISSUER`               | `faultline` | `iss` claim, written and required                                           |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`   | `3600`      | 60–86400                                                                    |
| `AUTH_PASSWORD_RESET_TTL_SECONDS` | `1800`      | Single-use reset-link lifetime; 300–86400                                   |
| `AUTH_MFA_REQUIRED`               | `false`     | Confines unenrolled accounts to authenticator setup when true               |
| `AUTH_MFA_ENCRYPTION_KEY`         | JWT-derived | Separate ≥32-character TOTP encryption key; recommended                     |
| `AUDIT_INTEGRITY_KEY`             | dev-derived | ≥32 chars; required explicitly for the production API                       |
| `AUDIT_INTEGRITY_KEY_ID`          | `primary`   | Identifier stored with each signed record                                   |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL`      | —           | Seeds the first Admin, only while `users` is empty                          |
| `AUTH_BOOTSTRAP_ADMIN_PASSWORD`   | —           | Both or neither; 12–128 chars with uppercase, lowercase, number, and symbol |

Unset both bootstrap values once you have signed in — an env file is not a credential
store.

## Getting in

```bash
npm run db:migrate                 # applies 0010_rbac_and_audit
npm run faultline:start            # the bootstrap Admin is seeded on first start
```

Or create accounts directly, which also works when the last Admin password is lost:

```bash
npm run user:create   -- --email admin@you.io  --name "Admin" --role admin --password "Strong-password1!"
npm run user:create   -- --email ahmed@you.io  --name "Ahmed" --role onsiteengineer --password "Strong-password1!" --projects project-a,project-c
npm run user:assign   -- --email ahmed@you.io  --project project-a
npm run user:unassign -- --email ahmed@you.io  --project project-a
npm run user:role     -- --email ahmed@you.io  --role admin
npm run user:password -- --email ahmed@you.io  --password "..."
npm run user:disable  -- --email ahmed@you.io
npm run user:list
```

`user:role` and `user:disable` refuse to remove the last active Admin.

Every newly chosen or administrator-assigned local password must contain 12–128
characters, including uppercase and lowercase letters, a number, and a symbol. Password
change and recovery also verify against the stored scrypt hash and reject reuse of the
current password.

## Enterprise identity (SSO / OAuth / LDAP)

Not wired, but the shape is deliberate:

- Tokens are standard HS256 JWTs verified in one place (`packages/auth/src/tokens.ts`).
  Pointing at an external issuer means replacing `verifyAccessToken` with RS256
  verification against a JWKS; no caller changes, because nothing else parses a token.
- `users.external_subject` already exists for the IdP's `sub` claim, and
  `password_hash` is nullable for users who have no local credential.

## Authenticator MFA

Users enroll from **Account Security** using any RFC 6238 TOTP authenticator. Enrollment
requires the current password and a valid first code. Secrets are AES-256-GCM encrypted
at rest, recovery codes are stored only as keyed digests, login challenges expire after
five minutes, and a TOTP counter or recovery code can be consumed only once.

An enrolled account always completes `POST /auth/mfa/verify` before an access token is
issued. With `AUTH_MFA_REQUIRED=true`, an unenrolled account receives a password-authenticated
session that the backend confines to `/auth/me`, logout, password change and MFA setup.
The React redirect is explanatory; the global authorization guard applies the lock.

Use a stable `AUTH_MFA_ENCRYPTION_KEY` in production. When it is absent, a domain-separated
key derived from `AUTH_JWT_SECRET` is used, so rotating that JWT secret also invalidates
the encrypted authenticator secrets.

## Password recovery

`POST /auth/forgot-password` always returns the same accepted response for a valid email
shape, whether or not an active local account exists. For a matching account it emails
a link to `/reset-password` containing 32 random bytes. PostgreSQL stores only the
SHA-256 digest, expires the link after `AUTH_PASSWORD_RESET_TTL_SECONDS`, and invalidates
an older link when a newer one is requested.

`POST /auth/reset-password` atomically consumes the link, stores the new scrypt hash,
clears temporary-password confinement, and increments `users.session_version`. The
authentication guard compares that version with the JWT `sv` claim, immediately
revoking access tokens issued before the reset. MFA configuration is preserved and is
still required on the next login. Production API deployments require
`EMAIL_TRANSPORT=smtp`; development's `log` transport writes the reset email to the API
log for local testing.

## Known limitations

1. **Audit storage is fail-closed.** A failed audit write is logged at `error` level and
   propagated, so the API never reports an audited action as allowed without its audit
   evidence. Records tied to a known account carry `organization_id`, and the admin
   audit endpoint always applies the authenticated administrator's organization scope.
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
