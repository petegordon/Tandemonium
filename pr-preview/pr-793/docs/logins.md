# Logins and accounts (#783)

How House Tandem records who did what. This is the server model every game shares.

## The model

- A **login** is one sign-in: a Discord, a Steam, a Google, or a guest's device. It is a row
  in `user_logins` with a `login_id` that never changes.
- An **account** is a `users` row. One or more logins belong to it (`user_logins.user_id`).
- **Every record carries both ids:**
  - `login_id`: the login it was recorded under. Set once.
  - `user_id`: the account that login belongs to now. A copy, so queries need no join.

A session token is a login (`lid`). Its account is whatever account that login belongs to
today (`resolveSession`), so a session follows its login through a combine or a separate.

## Combine and separate

- **Combine B into A:** B's logins point at A, and every row with `user_id = B` gets
  `user_id = A`. B's `users` row is removed, and what moved is kept on the account event.
- **Separate:** B comes back with its number, name and picture. Each login that came with it
  returns, and every row with that `login_id` gets `user_id = B` again, including rows
  recorded while the accounts were combined.
- **Remove a linked sign-in:** that login gets a new account of its own, with what it recorded.

No rows are merged or copied, so a separate is exact. `worker/accounts/combine.js` does the
updates. It names no game's table: each game registers the tables that carry the two ids
(`registerAccountTables`).

## Rules that are about a person, not a login

The database's unique keys are per login. The per-person rule is applied when reading by `user_id`.

| Data | Stored | Read as one account |
|---|---|---|
| Badges (`user_achievements`, `game_achievements`) | one per login | once, with the earliest date. A badge the account already has is not recorded again |
| Daily (`daily_results`) | one row per login, day and mode: its best time | the better of its logins' rows |
| Stats (`game_stats`) | one row per login and game, plus each stat's rule (`ops_json`) | combined by rule: add, max, union… |
| Time played (`game_playtime`) | per login and game | summed. The cap on a report is per account |
| Pairs (`pairs`) | one row per pair of logins | two people's record is the sum of their logins' rows |
| Discord posts | per login | one a day per account, checked on write |

## Guests

A guest is a login with provider `device`, keyed by a guest key (an HMAC of the device id, so
the id itself is never stored or shown to a partner). It has a small account of its own and
never appears on a leaderboard, because a device login can't sign in to post.

When that device signs in, the device login joins the account with everything recorded
under it. Its key is then retired, so the next guest on that device starts a new record.

## Module boundary

`worker/accounts/` is the account system: logins, sessions, sign-in, link, combine, separate,
notices. It imports nothing from outside its folder (a unit test enforces this), so it can
move out of this repo later. Games reach it through:

- `resolveSession(env, claims)` → the claims with `sub` (account) and `lid` (login) as they stand now
- `sessionFor(env, userId, deps, login)` → a session token for a login
- `registerAccountTables([{ table, user, login }])`
- `ensureDeviceLogin(env, guestKey)`, `firstLogin(env, userId)`

Other House Tandem game Workers use the `HouseTandemGames` RPC (`worker/index.js`).
`resolveDiscord` and `verifySession` now return `loginId`; pass it back to `recordGame` and
`recordPlay` so the write is recorded under that login. Until a game does, its writes go
under the account's Discord login.

## Databases

- **Production:** `tandemonium-leaderboard`.
- **Staging:** `tandemonium-leaderboard-staging`, with its own API
  (`tandemonium-api-staging`, `--env staging`) and its own secrets. No Discord or Steam
  secrets are set there: test with tokens signed by staging's `JWT_SECRET`.

**Staging and production share one daily write allowance.** On Cloudflare's free plan an
account may write 100,000 rows a day across all its D1 databases; past that, writes are
refused until midnight UTC. A full copy of production is about 320,000 rows (nearly all of
them analytics `events`), so importing one into staging uses up the day and production
sign-ins fail (this happened on 2026-11-17). When rehearsing, leave `events` and
`ride_events` out of the import, or be on the Workers Paid plan.

## Shipping migration 0021

The new code needs the new tables, and the old code needs the old ones, so the migration and
the deploy go together. Do it at a quiet time; players see errors for well under a minute.

1. **Back up.** From `worker/`:
   `npx wrangler d1 export tandemonium-leaderboard --remote --output <file>`.
   Keep the file off the repo (it holds emails and IP addresses).
2. **Rehearse** on staging: import the export, run the migration, check the totals.
   Done 2026-11-17: 41 accounts, 507 rides, 302 badges, every per-account total unchanged.
3. **Migrate production:**
   `npx wrangler d1 execute tandemonium-leaderboard --remote --file migrations/0021_logins.sql`
4. **Deploy at once**, from the branch, without waiting for CI:
   `npx wrangler deploy --config wrangler-api.toml` and `npx wrangler deploy --config wrangler.toml`
5. **Check:** sign in, open the profile, post a ride.
6. **Merge the PR** (the workflow deploys the same code again).

To go back: restore the export into a new database and point `wrangler-api.toml` at it, with
the previous worker version (`npx wrangler rollback`).

## What existing data looks like after the migration

- Every existing row is credited to its account's earliest login. We never recorded which
  login made it, so this is the honest default.
- Guests in pair records became device logins.
- Combines made before the migration can no longer be separated (they were recorded the old
  way). Links can still be removed.
