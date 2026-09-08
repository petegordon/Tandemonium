# Tandemonium — Ideal Customer Persona (ICP)

A single, standardized persona document for the player we are building Tandemonium for. Uses a common B2C game-marketing persona template so it can be plugged into store-page copy, ad creative, playtest recruiting, and feature-prioritization decisions.

---

## 1. Persona Snapshot

| Field | Value |
|---|---|
| **Persona name** | "Co-op Casey" |
| **Archetype** | The Remote Co-op Duo |
| **Tagline** | *"Send me the link — I'll join from my phone."* |
| **Photo / vibe** | Late-20s to mid-30s, laptop open on the kitchen table, phone propped against a coffee mug, on a voice call with their partner/sibling/best friend who is on their *own* device in another room — or another city. Two screens, two players, one bike. |

> **Important:** Tandemonium is **online multiplayer, one-screen-per-player** (PeerJS P2P with Cloudflare relay fallback). There is no local split-screen or shared-controller mode, and the persona is deliberately built around that strength — not around couch co-op.

---

## 2. Demographics

| Field | Value |
|---|---|
| **Age range** | 24–40 (core), with a secondary 10–15 family segment reached via the primary buyer |
| **Gender** | All; skews slightly toward mixed-gender couples and parent-child pairs |
| **Location** | North America, UK, Western Europe, ANZ (English-first launch markets) |
| **Household** | Has a **regular play partner they see mostly online** — a long-distance partner, a sibling in another state, a college friend group, a parent/kid who plays from separate rooms, or a spouse who is happy to play from their own phone on the couch |
| **Occupation** | Knowledge worker, student, teacher, creative, or stay-at-home parent |
| **Household income** | $45k–$120k USD — comfortable with $10–$20 indie purchases and occasional DLC |
| **Education** | College-educated or equivalent; tech-literate but not necessarily a "gamer identity" |
| **Devices owned** | A gaming laptop or mid-range PC **plus** a smartphone with a gyroscope. Casey's play partner owns *at least* a smartphone — that's the minimum bar to join, and the whole point. Steam Deck, a TV, and modern gamepads (DualSense / Switch Pro / Xbox) are nice-to-haves, not requirements |

---

## 3. Psychographics

- **Motivations**
  - Shared laughter and "we did it together" moments over solo mastery — **especially with someone they can't be in the same room with**.
  - Lightweight, *pick-up-and-play* sessions that fit a 15–30 minute window.
  - Keeping a **ritual** with a long-distance partner, sibling, or friend group (think: weekly "game night over Discord").
  - Novelty mechanics they can show off to friends ("wait, you both pedal from different houses?").
  - Nostalgia for goofy physics games (QWOP, Human Fall Flat, Overcooked, Trackmania) — but without the "everyone has to own the same game" tax.
- **Values**
  - Inclusivity — games that a non-gamer partner can actually play without a tutorial wall.
  - Fair, one-time purchases; skeptical of grindy monetization and battle passes.
  - Creators and indie devs who ship polish over hype.
- **Personality traits**
  - Social, patient, forgiving of their own mistakes, and willing to teach.
  - Prefers "funny failure" loops to punishing, skill-gated ones.
- **Gaming identity**
  - Calls themselves a "casual" or "cozy" gamer even if they play 5+ hours a week.
  - 50–150 Steam games in library; 10–20 of them are co-op.

---

## 4. Goals & Jobs-to-be-Done

When Casey "hires" Tandemonium, they hire it to:

1. **Keep a ritual alive with someone they can't be in the room with** — long-distance partner, sibling, old college friend — in under 30 seconds of setup.
2. **Create a shared 20-minute laugh** with their partner, kid, or roommate, each on their own device, already on a voice call or sitting nearby.
3. **Feel coordinated with another human** — a light skill-expression loop that rewards rhythm, not reflexes, and *requires* two real people (no bots, no carry).
4. **Have something new to stream / TikTok** that looks funny in a 15-second clip — ideally showing both players' faces via the built-in video/PiP.
5. **Play on whatever device each person has** — captain on a laptop, stoker on a phone with gyro; no second purchase, no install on the stoker's side.

---

## 5. Pain Points & Frustrations

- **Friends and family live in different cities** — local / couch co-op is literally not an option anymore.
- Most online co-op games require **two copies, two accounts, and a matchmaking lobby**.
- Their play partner **doesn't own a PC or a console** — only a phone.
- Partner/kid **bounces off tutorials** that assume gamer literacy.
- Mobile co-op games are **pay-to-win or ad-riddled**.
- Voice chat setup is a **nightmare** — they want to just send a link.
- Physics/party games often feel **unfair or random** rather than *coordinated*.
- Online co-op games that secretly require **one dominant player** carrying the other.

---

## 6. How Tandemonium Solves Their Problem

| Pain | Tandemonium's answer |
|---|---|
| Friends in other cities | **PeerJS WebRTC P2P** with a **Cloudflare Worker relay fallback** — low-latency online play that "just works" behind NAT/firewalls |
| Two copies required | **One browser link** — the stoker joins free via room code, no install, no account, no second Steam purchase |
| Partner has no PC/console | **Captain on laptop, stoker on phone** with gyro tilt works out of the box — Tandemonium runs in the browser on both sides |
| Tutorial wall | **Tutorial level** with coaching arrows, DDA, and no timer; anyone can finish their first ride |
| Cross-device friction | Plays in **browser, Steam, Electron desktop, TV mode, and mobile with gyro** — any captain device pairs with any stoker device |
| Unfair party chaos | **Offset-pedaling mechanic** turns coordination into the actual game — success feels earned, failure is funny, not random |
| Grindy monetization | **One-time purchase**, promo codes, optional cosmetic bikes; demo + Steam playtest available |
| Carry dynamic | Captain and Stoker roles **depend on each other** — neither can win alone |

---

## 7. Buying Triggers

- Sees a **15-second clip** of two players wobbling through Grandma's level on TikTok / Reels / YouTube Shorts — ideally with both webcams visible.
- A **Steam curator or indie newsletter** they trust ("Cozy Co-op Weekly", "Long-Distance Co-op") features it.
- Long-distance partner says *"I want to play something tonight — do you have a link?"* — highest-converting trigger.
- **Steam Next Fest / Playtest demo** — they try the free demo, laugh once, wishlist.
- A friend **sends them a room code link** and they're in the game as a stoker *before* deciding to buy. They convert to captain later. (The stoker-CTA overlay exists for exactly this moment.)
- **Holiday content** — Christmas-themed tracks ("Krampus Workshop", "Gold Rush") trigger seasonal gifting intent, especially for far-away family.

---

## 8. Buying Objections

- *"Will my partner actually be able to play this?"* → Tutorial + safety mode + gyro tilt.
- *"Is this just a phone game?"* → Steam page + TV/desktop mode + controller support.
- *"Can I play with my friend in another city?"* → P2P multiplayer with relay fallback.
- *"Is $X worth 2 hours of content?"* → Replay via leaderboards, achievements, bike unlocks, and multiple levels (Grandma's, The Castle, …).
- *"Do I need to sign up for another account?"* → Optional Google/Steam sign-in; stoker needs nothing.

---

## 9. Channels — Where Casey Actually Is

- **Steam** (wishlist, Next Fest, curators, Deck Verified badge)
- **TikTok / Instagram Reels / YouTube Shorts** — short funny-fail clips
- **YouTube** — couples/co-op channels, "games to play with your partner" lists
- **Reddit** — r/CoopGaming, r/ShouldIBuyThisGame, r/IndieGaming, r/SteamDeck
- **Discord** — indie game showcase servers, cozy-gaming communities
- **Podcasts / newsletters** — Cohost-adjacent indie newsletters, Into the Aether-style pods
- **Word of mouth** — the "send a room code" link is itself a channel

---

## 10. Messaging That Resonates

Short, testable value props ordered by priority:

1. **"Send a link. Ride together."** — the zero-friction online-co-op hook
2. **"A tandem bike. Two players. One crank. Good luck."**
3. **"They don't need Steam. They don't need a PC. They need a phone and a room code."**
4. **"Pedal in sync. Or don't. It's funnier when you don't."**
5. **"Laptop here. Phone there. Same bike."**

Avoid: "couch co-op" / "2nd controller" / "grab a friend on the couch" framing — the game does not support local multiplayer. Also avoid hardcore-gamer, competitive/esports, or "skill-based" framing.

---

## 11. Anti-Persona (who this is *not* for)

- **Hardcore sim-racing fans** looking for realistic bike physics and setup depth.
- **Competitive PvP players** who want ranked ladders and anti-cheat.
- **Lone-wolf completionists** who never touch multiplayer — they can enjoy solo mode, but they are not the ICP.
- **Free-to-play mobile whales** expecting gacha/loot systems.
- **Kids under ~8** without a parent co-playing (reading / coordination curve).
- **Couch-co-op-only buyers** who want two controllers on one screen — Tandemonium is online-only, one-screen-per-player. If they don't have a remote play partner and aren't willing to hand a phone to the person next to them, this is not for them.

---

## 12. A Day in Casey's Life (Scenario)

> It's Tuesday, 9:40pm. Casey is on FaceTime with their partner who lives two time zones away. Partner says *"one more thing before bed?"* Casey opens the laptop, launches Tandemonium, picks **Ride Together → Captain**, and reads a room code into the call. Partner taps the shared link on their phone, selects **Stoker**, and lands in the lobby 8 seconds later — no install, no sign-in, nothing to buy on their side. They pick **Grandma's**, wobble off the start line, crash into a tree, laugh (the video PiP shows both their faces), restart, and finish the run 3 minutes later with a new personal best. Total session: 12 minutes. Casey wishlists the next level pack on the victory screen. Partner is already asking "same time tomorrow?"

---

## 13. Success Metrics for "Reaching Casey"

| Signal | Target |
|---|---|
| **Stoker → Captain conversion** (stoker plays free, later buys to host) | ≥ 20% within 30 days |
| **Second-session retention** (D1 return after first co-op session) | ≥ 45% |
| **Wishlist → purchase** around Next Fest / seasonal sale | ≥ 12% |
| **Clip shareability** (share sheet / record button uses per session) | ≥ 0.3 |
| **Cross-device sessions** (captain desktop + stoker mobile) | ≥ 35% of MP sessions — this is the defining shape of the ICP |
| **Repeat-pair sessions** (same two peer IDs / accounts playing together ≥ 2x) | ≥ 40% of MP pairs — proves the "ritual with a specific person" JTBD |

---

## 14. Template Source

This document uses a standardized B2C persona template combining:

- **Demographics + Psychographics** (traditional marketing persona)
- **Jobs-to-be-Done** (Christensen)
- **Pain / Gain / Message** (Value Proposition Canvas)
- **Anti-persona** (product discovery best practice)

Update this file when a playtest, survey, or analytics cohort materially changes who is actually buying and recommending Tandemonium.
