# June Demo Delivery Plan — Press Drop (Jun 4) + Steam Next Fest (Jun 15–22)

**Drafted:** 2026-04-23 (6 weeks out)
**Branch:** `claude/plan-june-demo-delivery-yzRN4`

## Hard constraints (from Pete, 2026-04-23)

- **No physical press event / no booth.** June 4 is a coordinated digital **press drop**, not a live demo floor.
- **Demo must be fully free and publicly available no later than June 4.** No demo-key gating, no "unlock on Jun 15." Steam Next Fest (Jun 15–22) is a *second* marketing moment on top of an already-live demo.
- **No press embargo, no private Steam branch.** The gating mechanism during development is an **invite-only playtest** — everyone outside the invite list waits for the public drop.
- **No full-game keys available either.** If we don't have the full game done by June 4, creators get the same public demo everyone else gets. That's the deal.
- **Users First Games, Open Source, and Open Company are co-headline messaging.** The June 4 announcement is not only "demo is live" — it's also "here's the studio, here's how we build, here's the repo." These three have to ship together.
- **Columbus Code and Coffee — May 17.** In-person playtest AND soft-launch of Users First Games to the local dev community. This is the public debut of the company identity, ~18 days ahead of the wide press drop.
- **Steam has de-emphasized livestreams during Next Fest.** No live broadcast is required for the algorithm. Optional only — spend the energy on trailer, wishlist pushes, and community.

## The two hard deadlines

1. **Sun May 17 — Columbus Code and Coffee:** Users First Games soft-launch + public-ish playtest of the demo candidate (local dev community, not press).
2. **Thu Jun 4 — Public Press Drop Day:**
   - Steam demo live (free, public, no key).
   - Users First Games / Open Company announcement goes out.
   - Press release + press kit + trailer + open-source repo spotlight published simultaneously.
   - Outreach email blast hits inboxes at the agreed send time.

## Prerequisites to confirm this week

Flag any "no" immediately — they change the shape of the plan.

- Steam Next Fest registration accepted for Jun 15–22.
- Steam store page live, demo-linked app ID created in Steamworks.
- Users First Games legal / brand assets ready: name locked, logo, domain, one-sentence positioning, "Open Company" policy draft (what we publish, what we don't, how external contribution works).
- Press-list tooling ready (even just a Google Sheet: contact, pitch date, replied, covered, link).
- Columbus Code and Coffee slot confirmed with the organizers for May 17, including AV / power / tables and permission to record reactions.

---

## WEEK 1 — Apr 23–29: Scope lock + demo-candidate branch

**Goal:** freeze what ships in the public June 4 demo. Everything else is post-fest.

- **Thu Apr 23** — Write a one-page demo scope doc. Decide: which courses ship (Grandma's House only or both?), how many of the 7 bikes unlocked, achievements on/off for demo, leaderboards on/off, solo + local co-op + online co-op all enabled or a subset, session length cap, exit/reset flow.
- **Fri Apr 24** — Triage open issues with `demo-blocker` / `demo-nice-to-have` / `post-demo` labels. Anything unlabeled = deferred.
- **Sat Apr 25** — In-house couch co-op playtest (2 trusted people). Notebook only. Capture first-5-min confusion, crash logs, local-MP edge cases.
- **Sun Apr 26** — Convert playtest findings into issues on the `demo-june` branch.
- **Mon Apr 27** — Draft the Users First Games one-pager: mission, Open Source stance, Open Company commitments, how people can contribute. This is the *narrative* backbone — everything else (press release, site copy, social) quotes from it.
- **Tue Apr 28** — Attract-mode / idle screen. Required so the game sells itself in a gif, in a stream, in a store-page video.
- **Wed Apr 29** — Cut **Build A (internal alpha)**. Install on a clean machine. If it doesn't run, that's a bug.

## WEEK 2 — Apr 30–May 6: Invite-only playtest #1 + press kit v1

**Goal:** first outside-the-team eyeballs (under the invite-only playtest banner). Marketing assets enter draft.

- **Thu Apr 30** — Recruit 3–5 playtesters (friends-of-friends, local dev Discord). Couch co-op is the priority — each tester brings a partner or we pair them.
- **Fri May 1** — Invite-only playtest session #1. OBS + webcam on the couch. Watch: do they grok offset pedaling without a tutorial? Can P2 figure out JOIN RIDE? First-crash recovery flow?
- **Sat May 2** — Press kit v1 draft:
  - 60-sec trailer cut.
  - 10 screenshots at 1920×1080 and 3840×2160.
  - One GIF per hook (crash, perfect sync, finish line).
  - Fact sheet: studio = Users First Games, devs, platform (Windows + web), price = free demo, release window.
  - **Open Source + Open Company section** — link to the GitHub repo, contribution guide, short "how we work" blurb.
  - Host at a `/press` page on the site or presskit.to.
- **Sun May 3** — Rest / fix only critical regressions.
- **Mon May 4** — Influencer/press longlist, three buckets:
  - **Couch co-op / party game creators:** ProZD, Let's Game It Out, Call Me Kevin, Chilled Chaos, The Completionist, SpyCakes, DashieGames, Dan & Phil Games, NotYourAverageGamer, Northernlion-adjacent.
  - **Indie press:** Rock Paper Shotgun, PC Gamer indies desk, Eurogamer, Indie Game Website, Destructoid, Siliconera, NoClip.
  - **Open-source / dev-culture press:** Hacker News, Lobsters, /r/gamedev (rules!), GitHub Trending (organic), The Register, any "built in public" podcasts (Indie Hackers, Software Engineering Daily if they bite), Thomas Frank, Fireship if a hook lands.
- **Tue May 5** — Write the press email template (< 150 words). Lead with the twin hook: "Tandem bike physics co-op — offset pedals mean you can't just both mash forward" + "built by Users First Games as an Open Company in public." One GIF, one presskit link, one ask: cover the June 4 drop.
- **Wed May 6** — Cut **Build B (playtest candidate)**. Smoke test on 3 hardware configs.

## WEEK 3 — May 7–16: Final polish before Columbus Code and Coffee

**Goal:** the build that shows up May 17 is the build we'd be comfortable launching publicly. Columbus is effectively a public soft-launch to the dev community.

- **Thu May 7** — Invite-only playtest #2. Different group than #1. Measure time-to-first-finish for a pair that's never played.
- **Fri May 8** — Finalize Users First Games public materials: website/landing page, "Open Company" manifesto, repo README polish (contribution guide, code of conduct, good-first-issue labels), license confirmed, public project board live.
- **Sat May 9** — Invite-only playtest #3 in a public-ish venue (bar, coffee shop, board-game night). Strangers, no instructions, observe. This is your dress rehearsal for May 17.
- **Sun May 10** — Tier-2 outreach (next 20 contacts). Soft ask: "Code and Coffee launch May 17, public demo June 4 — can we get on your radar for either?" Start the tracker sheet.
- **Mon May 11** — Fix playtest blockers. **No new features.** Suggestions go in a "post-demo" bucket and are ignored until July.
- **Tue May 12** — Trailer v2 cut using real playtest reactions. Reactions sell couch co-op; staged b-roll doesn't.
- **Wed May 13** — Cut **Build C (Code and Coffee candidate)**.
- **Thu May 14** — **Submit demo to Steam for review.** Target go-live = June 4. Steam review is typically 1–5 business days but can drift; submitting 3 weeks early gives buffer for rejection + resubmit. Complete the age rating / content survey, not just the build.
- **Fri May 15** — Columbus logistics: hardware load-out (2 laptops, 4 DualSense + 2 Xbox, HDMI splitters, monitor or TV, gaffer tape, power strips, chargers, USB hub). Printed handouts (if any) with QR to repo + wishlist.
- **Sat May 16** — Full dress rehearsal on Code and Coffee hardware. Time a start-to-crash-to-retry loop. Practice the 2-minute Users First Games pitch out loud.
- **Sun May 17** — **COLUMBUS CODE AND COFFEE.** Two-track agenda:
  1. **Users First Games soft-launch** — short talk / Q&A about Open Company, Open Source, how Tandemonium got built.
  2. **Couch co-op playtest** — run pairs through the demo. Capture photos, short clips, and consented quotes. Push the repo star button.
  - Post-event same night: thank-you post naming attendees, 1 hero clip, link to repo + wishlist.

## WEEK 4 — May 18–27: Press drop prep + Steam review turnaround

**Goal:** June 4 assets are all drafted, reviewed, and scheduled. Steam demo is approved and staged for a June 4 go-live.

- **Mon May 18** — Columbus retro. Convert any issues uncovered during the event into tickets. Fix must-fix, defer the rest.
- **Tue May 19** — Press release v1 for Jun 4. Three headlines, pick one:
  - "Tandemonium demo launches free with Steam Next Fest — an Open Company couch co-op experiment."
  - "Users First Games open-sources a physics party game and drops the free demo."
  - "Build a bike with a stranger: Tandemonium's free demo is live, and so is the repo."
- **Wed May 20** — Outreach batch #1 goes out: top 10 press + creators. Personalized. Pitch = June 4 drop, offer the Code and Coffee clips as colour, note that demo is free + open-source so coverage has no gate.
- **Thu May 21** — Check Steam review status. If rejected, fix + resubmit same day. If approved, configure the depot to publish on June 4 at the coordinated time (suggest 9am ET to catch both US morning press and EU afternoon).
- **Fri May 22** — Social content calendar May 28 → Jun 22. ~15 posts: trailer, GIFs, Users First Games explainer thread, Open Company explainer, Columbus recap, countdown posts, Jun 4 drop, Jun 4 repo spotlight, Next Fest opener (Jun 15), mid-fest wishlist push, leaderboard bragging posts, fest closer.
- **Sat May 23** — Invite-only playtest #4 on the exact build we intend to publish. One bug-bash pass, tight scope.
- **Sun May 24** — Wishlist warm-up #1: post in r/couchcoopgaming, r/IndieDev, r/IndieGaming, r/gamedev (follow rules), Discord, Bluesky, LinkedIn (Open Company angle plays well there). Goal: bank wishlists *before* Jun 4. Wishlist velocity on launch day is what Steam's algorithm rewards.
- **Mon May 25** — Outreach batch #2 (next 20 contacts). Send chase emails to batch #1 non-responders.
- **Tue May 26** — Contingency day. Unfixed bugs are now post-demo.
- **Wed May 27** — **Draft every Jun 4 artifact in final form:** press release, tweet thread, LinkedIn post, Hacker News "Show HN" title + body, blog post, email to mailing list, Discord announcement, repo README banner, Steam announcement post. Schedule everything that can be scheduled.

## WEEK 5 — May 28–Jun 3: Lockdown

**Goal:** no code changes except demo-blocker fixes. All content queued.

- **Thu May 28** — **Public demo build golden master (Build D).** Tag the commit. Upload to Steam depot for Jun 4 release. Confirm Steamworks schedule.
- **Fri May 29** — Outreach batch #3 (long tail — Twitch streamers in the 1–10k concurrent range, they convert best for niche co-op). "Demo is free on June 4, no key needed."
- **Sat May 30** — Final repo polish: contribution guide skim, issue templates, `good-first-issue` labels seeded, license + code of conduct in place. Somebody star-clicking on June 4 should land on a tidy house.
- **Sun May 31** — Rest.
- **Mon Jun 1** — **Demo build locked.** Sanity check Steam review is done and the Jun 4 go-live is armed. If it's not, escalate today.
- **Tue Jun 2** — "48 hours out" reminder email to press + creators with presskit link, trailer, and the exact go-live time. Hacker News / Lobsters drafts get a second pair of eyes.
- **Wed Jun 3** — "24 hours out" social teasers. Quiet day for dev — use it to line up press-release distribution, finalize the Jun 4 livestream if we choose to do one, rehearse responses to common questions (monetization? open-source license? full game date? why tandem bikes?).

## DROP DAY — Thu Jun 4

Coordinated launch windows, all in one day. Suggested Eastern Time schedule:

- **09:00 ET** — Steam demo goes live.
- **09:05 ET** — Press release out, email blast, trailer public on YouTube.
- **09:15 ET** — Tweet/Bluesky thread. LinkedIn post with Users First Games / Open Company framing.
- **09:30 ET** — Hacker News "Show HN: Tandemonium — an open-source couch co-op tandem bike game" submission.
- **10:00 ET** — Discord + mailing list.
- **All day** — Monitor Steam discussions, GitHub issues, HN/Reddit comments. Respond quickly and warmly. Every first-day bug report gets a reply, even if it's "thanks, logged."
- **Evening** — Recap post: GIFs from real Day-1 players, thanks to Columbus crew, link to the repo contributor graph.

## POST-DROP — Jun 5–14

- **Fri Jun 5** — Personal thank-you notes to press + creators who covered. Push patch #1 (Day-1 bugs) to a Steam staging branch; promote once tested.
- **Sat Jun 6–Tue Jun 9** — Ship one small patch every 48 hours. Each gets a changelog blog post. Visible iteration reinforces the Open Company narrative.
- **Wed Jun 10** — "Next Fest starts in 5 days" wishlist push. Fresh trailer cut if we have new reaction clips.
- **Thu Jun 11–Sun Jun 14** — Daily GIF or dev-diary post. Answer every DM same-day. Track wishlist velocity so we can compare against the Jun 15 bump.

## STEAM NEXT FEST — Jun 15–22

Demo already live since June 4, so this is a *visibility* event, not a *launch* event. Focus shifts to funneling the Next Fest traffic bump into wishlists and repo stars.

- **Mon Jun 15** — Fest opens. Update store page capsule / header to reflect Next Fest badge. Refresh announcement post. Monitor traffic, reviews, and repo traffic graph.
- **Tue Jun 16** — Optional livestream (no longer algorithmically weighted — only do it if we have an authentic pair ready to play on camera). If we stream, it's 2 devs playing couch co-op, not a scripted demo.
- **Wed Jun 17–Fri Jun 19** — Community highlight post (best player clips), dev-diary post (what's next after demo), Open Company "what we learned in public" post.
- **Sat Jun 20** — Mid-fest wishlist push. Post milestone numbers if they're flattering.
- **Sun Jun 21** — "Last 36 hours" push.
- **Mon Jun 22** — Fest closes. Leave demo live. Write the public Next Fest retrospective (wishlists, repo stars, contributors, bugs reported, bugs fixed) — this is evergreen Open Company content.

## Hot risks

1. **Steam review delay.** Submit by May 14 to have 3 weeks of buffer before Jun 4. If rejected, the window to fix and resubmit closes fast.
2. **No full game, no keys to give.** Creators who expect key access for "full review" will pass — that's okay. Lean into the "free demo, open repo" pitch; it removes the gating question entirely.
3. **Users First Games launch confusion.** Three announcements on one day (company, open-source repo, demo) can muddy each other. The press release should tell it as a single story in this order: company → philosophy → game, with the demo as the first proof.
4. **Local MP controller edge cases.** Recent issues (#271, #266, #256) cluster here. Budget a bluetooth-hostile environment soak in Week 4 (lots of other devices nearby — simulate Columbus + Next Fest conditions).
5. **Columbus Code and Coffee doubles as a soft-launch.** If Build C there is embarrassing, that story follows us to June 4. Treat May 16's rehearsal seriously.
6. **Open repo + free demo = zero friction for negative coverage too.** Plan for at least one public critique. Respond calmly, in public, with a fix or a reasoned disagreement. That response is itself Open Company content.

## Suggested next actions

- Confirm or correct the Week 1 scope doc bullet list.
- Lock the Users First Games one-pager (Mon Apr 27 deliverable).
- Decide whether the Jun 4 announcement leads with the company or the game.
- Pick the Steam submission date (recommended May 14) and back-plan any code freezes from there.
