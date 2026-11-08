// The tandemonium-api Worker's entry (wrangler-api.toml `main`).
//
// leaderboard.js is the public HTTP API. HouseTandemGames is a private RPC
// entrypoint for other House Tandem game Workers (dice first): they bind it as
// a service binding, so it's never reachable from the internet and needs no
// shared secret. Kept out of leaderboard.js because `cloudflare:workers` only
// exists in the Workers runtime, and the unit tests import leaderboard.js.
import { WorkerEntrypoint } from 'cloudflare:workers';
import worker, { houseTandemGames } from './leaderboard.js';

export default worker;

export class HouseTandemGames extends WorkerEntrypoint {
  /** The House Tandem account for a verified Discord user, created if new. → { userId, name, avatar } */
  resolveDiscord(profile) { return houseTandemGames.resolveDiscord(this.env, profile); }
  /** A House Tandem session token from a website sign-in. → { userId, name, avatar } | null */
  verifySession(token) { return houseTandemGames.verifySession(this.env, token); }
  /** → { earned: string[], stats } */
  gameProfile(userId, game) { return houseTandemGames.gameProfile(this.env, userId, game); }
  /** → { newlyEarned: string[] } */
  recordGame(userId, game, delta, earned) { return houseTandemGames.recordGame(this.env, userId, game, delta, earned); }
  /** Active seconds played since the last report (a delta; capped to real time). → { seconds, sessions, firstPlayed, lastPlayed, added } */
  recordPlay(userId, game, seconds) { return houseTandemGames.recordPlay(this.env, userId, game, seconds); }
}
