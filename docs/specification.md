# Multiplayer word territory game — implementation specification

Status: implementation baseline, version 1.2. Prepared September 23, 2026.

## Approved implementation updates — September 24, 2026

These updates supersede the corresponding initial defaults below:

- Dictionary: SCOWL release 2026.02.25, American English size 60, variant level 1, with documented metadata/case/character filtering. Bundle the 78,659-word artifact and upstream notices offline, verify checksums, and provide a reproducible extraction script. Both human validation and bots use this list.
- New board distribution: approximately 20% X/J/Q/Z, 50% A/E/I/L/N/O/R/S/T/U, and 30% other letters. Round hard/easy counts to nearest tiles and use the remainder for others. Guarantee U/E/T/S, at least 25% vowels, and at least 20 constructible words. Existing active boards are preserved.
- UI: show the current word in a dedicated box above the grid; tint score cards and color numeric score badges to match each player's tile color. Preserve non-color player markers.
- Word composition uses the same tile renderer as the board, including ownership color and protection markers. Allow mouse/touch drag reordering and an Alt+Left/Right keyboard alternative; submit ordered tile IDs after reordering. Board selection must retain ownership colors. Reduce desktop board width by approximately 15% and increase letter size, preserving 40px mobile tile targets.
- A word may be accepted only once per game, across all players and physical tile choices. Add regression coverage for all seats and repeated-letter tile alternatives.
- Defended tiles use a deeper, more saturated player shade with contrasting white letters and the diamond marker. Preserve this appearance in the board, selected state, and word composer; return to normal ownership color when defense is lost. Defense uses existing orthogonal neighbors and the pre-move board, as defined in section 3.
- Drag feedback must follow the finger/cursor while leaving a placeholder at the original word position. Remove floating feedback on drop, cancellation, or navigation. Replays announce newly observed opponent actions and highlight their word tiles in order. On page entry, replay only the latest action if its actor differs from the local player; unchanged polling must not repeat it. Passes use a text announcement. Honor reduced motion and never mutate game state or prevent the local player from interacting during replay.

## 1. Purpose and decision status

Build a browser game based on Letterpress, with configurable boards, two to four players, invite-based human participation, and a simple random-word bot. This document is the handoff for a coordinated implementation team. Deliver a working game, reproducible infrastructure, tests, and deployment documentation in a GitHub repository.

Confirmed by the user: GitHub repository; AWS shared backend; 2–4 configurable players; square board sizes from 5×5 through 7×7; a bot that finds a random word from the grid; joining through invite links without accounts; unit testing; a complete localhost mode.

Implementation defaults specified here: GitHub Pages frontend; English dictionary; at least one human player; host starts the game; fixed turn order; asynchronous play without a turn timer; original visual treatment and a placeholder product name, “Word Territory.” These defaults make the handoff actionable but are not additional user decisions. Final public name, GitHub owner/repository, AWS account/region, and budget notification recipient are deployment inputs, not reasons to block local implementation.

## 2. Release scope

Include create game, lobby, invite/join, human and bot seats, gameplay, persistent refresh/resume, results, instructions, and clear network/error states. Support phone and desktop browsers. Allow one human with up to three bots, or any other human/bot mix totaling 2–4 seats.

Exclude accounts, public matchmaking, spectators, chat, ratings, notifications, strategic bot difficulty, multiplayer without a running backend, payments, and mid-game seat replacement. Localhost mode includes a local backend and can run without internet after dependencies are installed. A disconnected human keeps their seat and turn; other players can return later. No automatic forfeits or timeout passes.

## 3. Rules contract

The original game supplies the core mechanics: form words, capture tiles, protect surrounded territory, forbid reused words and certain prefixes, and count territory at the end. See the [official rules](https://www.letterpressapp.com/how-to-play.html). The following exact algorithm is this project's contract, including explicit multiplayer and timing decisions where the source is not detailed.

### Board and words

- Choose side length 5, 6, or 7. Default: 5. Letters stay fixed throughout a match; all tiles start neutral.
- Each tile has a stable row-major integer ID, one uppercase A–Z letter, and an optional owner seat ID.
- Select distinct tiles in any order, anywhere on the board; adjacency is not required. A tile can occur at most once in a word. Repeated letters need separate matching tiles.
- A legal word has 2 through board-area letters and belongs to the pinned game dictionary. Proper nouns are excluded by dictionary preparation.
- Reject candidate W if any previously accepted word P equals W or starts with W. Thus QUARTZ blocks QUART, but QUART does not block QUARTZ. Apply across all seats and compare normalized uppercase strings.
- A legal word may capture zero tiles. It still consumes a turn and enters history.

### Turn resolution

1. Reject unless game is active, caller owns the current human seat (or is the trusted bot worker), revision matches, and the action is valid.
2. Compute defense from ownership BEFORE the move. An owned tile is defended if every existing orthogonal neighbor has that same owner. Corners have two neighbors, other edges three, interior tiles four. Diagonals do not count.
3. Derive the word from submitted ordered tile IDs and validate it. Never trust a client-supplied word or score.
4. Simultaneously assign selected neutral and undefended opponent tiles to the actor. Selected defended opponent tiles retain their owners. Selected actor-owned tiles remain theirs.
5. Recompute defense and scores from the resulting board. A tile that lost protection during this move can be captured on a later move, not retroactively in this move.
6. Append a history record, clear the consecutive-pass count, and check whether every tile is owned. If so, finish; otherwise advance to the next seat modulo player count.

Passing changes no ownership, appends history, increments consecutive passes, and advances the turn unless passes now equal the player count. Any successful word resets the count; rejected actions change nothing. Finish after all tiles are owned or every seat passes consecutively. Highest tile count wins; ties share the win. Finished games accept no new actions.

Order is host first, then configured seat order. No shuffling in v1. Invalid input never consumes a turn. Starting freezes seats, board size, rules version, and dictionary version.

### Board generation — project default

Use a versioned seeded generator. Proposed weights: A9 B2 C2 D4 E12 F2 G3 H2 I9 J1 K1 L4 M2 N6 O8 P2 Q1 R6 S4 T6 U4 V2 W2 X1 Y2 Z1. Draw with replacement. Require 25–50% vowels (A/E/I/O/U, inclusive after rounding inward) and at least 20 dictionary words constructible by letter counts. Try up to 100 seeds, then use a checked-in verified fallback board of the selected size. Persist seed and generator version; test fallbacks with the shipped dictionary. These weights and thresholds are design defaults, not claims about Letterpress's generator.

## 4. Dictionary and bot

Use an offline, reproducibly built English word list, packaged with the backend. Proposed source: [SCOWL / English Speller Database](https://github.com/en-wl/wordlist/blob/v2/README.md), American English, common vocabulary tier 60. The dictionary agent must pin an exact release/commit, record extraction settings and checksum, review included licensing notices, and commit the resulting artifact plus attribution. Do not fetch a changing dictionary at runtime or assume compatibility with the proprietary Letterpress dictionary.

Preserve source metadata until proper names, abbreviations, and non-word categories are filtered; lowercasing alone is not a proper-noun filter. Keep only alphabetic entries of length 2–49, deduplicate, then uppercase. Include inflections supplied by the source. Additions/exclusions require a reviewed versioned file. Existing games continue to use their recorded dictionary version; deploys must retain versions needed by unexpired games.

Bot algorithm:

1. Enumerate dictionary words whose letter counts fit the board and pass the shared history validator.
2. Select uniformly at random among distinct legal words, using reservoir sampling or an equivalent uniform algorithm. Do not weight by length, capture value, or number of tile assignments.
3. For each character, randomly select an unused tile with that letter. This avoids accidental territory strategy while resolving duplicate letters.
4. Submit through the same rules engine as a human. If no legal word exists, pass.

Use injectable randomness for tests. No external language-model service is required. Bot processing must continue with all browsers closed. Compute failures trigger retries/operational errors, never a fabricated “no words” pass. Target bot completion within five seconds under normal operation; show whose turn is pending.

## 5. Invite and identity behavior

Creating a game creates the host's human seat and a browser-held guest session. Host configures total seats and human/bot types in the lobby; unoccupied human seats are visibly open. Configuration changes are allowed before start, but may not delete an occupied human seat. Host can revoke/rotate the invite before start. Start requires every human seat filled and at least two total seats.

A shared invite admits a new participant to the next open human seat. Opening the link only displays the join screen; a Join action with a display name claims a seat. Claim seats atomically so concurrent joins cannot overfill the game. A full, started, expired, or revoked invite produces a useful message. Invites stop admitting new players when the match starts.

Use high-entropy opaque invitation and guest tokens (at least 128 bits from a cryptographically secure generator), stored as hashes server-side. An invitation is not a player credential and cannot authorize moves or reveal another player's credential. Store the guest bearer token in local browser storage; scope it to one game/seat. Explain that the same browser can resume, but clearing browser data loses access in v1. No email or identity recovery service is included.

Use a fragment invite route such as `/#/join/<inviteToken>` so Pages can serve the entry document and the token is not part of the HTTP URL. Exchange it through a POST body; remove it from the address bar after joining. Never log tokens or put session credentials in share links. Existing participants opening an invite should resume their seat. Lost create/join responses are retriable with an idempotency key and the same securely generated proposed guest credential; never claim an extra seat on retry.

Host-only rights cover lobby configuration and start, not editing accepted moves. API requests always verify seat authorization. Display names are 1–24 characters, trimmed, rendered as text, and unique within the lobby ignoring case; bot names are assigned and reserved.

## 6. Screens and interaction

**Home/create:** Short explanation, player count (default 2), board size, seat types (default host human plus one invited human), host name, Create button. Client validation mirrors server checks.

**Lobby:** Settings, occupied/open/bot seats, Copy invite button, explicit readiness, Start for host only. Show clipboard fallback and expired-link errors. Warn before navigating away if the browser cannot persist credentials.

**Game:** Board, ordered word tray, Clear, Backspace, Submit, Pass, current player, player scores, turn history, and rules help. Clicking a tile appends it; clicking a selected tile removes that occurrence without reordering others. Only the current human can compose/submit. Confirm passes. Show invalid-word, reused/prefix, stale-turn, offline, and server errors separately. Disable duplicate submission while a request is pending; on uncertainty refetch and reconcile before permitting a new action. Never optimistically commit ownership.

**Results:** Final board, scores, all winners or draw, and a Create another game link that prefills settings but creates a new lobby and invitation.

Use four distinguishable player colors plus visible player symbols; show defended tiles with a second non-color marker. Neutral, selected, defended, and owned states must remain distinguishable. Provide keyboard tile navigation, Enter/Space selection, focus indicators, accessible tile labels including position/owner/defense, and polite live announcements for turns/errors. At 320px viewport width, a 7×7 board must fit without horizontal scrolling and each tile target must be at least 40px. Respect reduced motion. Preserve the local selection across unchanged polls; clear it when the turn/revision changes.

## 7. Architecture

Recommended monorepo: TypeScript, React/Vite frontend, a framework-independent shared rules package, Node.js Lambda backend, DynamoDB persistence, AWS CDK infrastructure, and GitHub Actions. Pin supported dependency/runtime versions and lockfiles during implementation.

GitHub Pages hosts the static bundle; AWS API Gateway HTTP API invokes Lambda. Use authenticated polling for v1: every two seconds while a lobby/game tab is visible, slower with exponential backoff on errors, pause while hidden, and refresh immediately on focus. This turn-based game does not require WebSockets. Pages is [static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages); AWS documents [Lambda integration with API Gateway](https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway-tutorial.html).

All mutations are authoritative on the backend. Use revision-conditional writes to prevent concurrent moves; DynamoDB supports [conditional expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.html). Use transactions to commit state, history, and idempotency records together. Read current state consistently when resolving races.

Use DynamoDB Streams on committed game revisions to trigger bot-turn Lambda work. Every bot invocation checks game ID, expected revision, and current bot seat; stale/duplicate work is a no-op. A successful bot action creates the next stream event, supporting consecutive bots. Configure bounded retries, a failure destination and alarm; provide a documented replay procedure. A scheduled recovery Lambda checks a sparse pending-bot index every minute and retries overdue work, preventing a failed trigger from permanently stalling a match.

### Localhost mode — required

Provide a fully playable local frontend, HTTP API, persistent database, and bot runner. After installing the documented Node.js version and running `npm ci`, `npm run dev` starts everything at `http://localhost:5173`, with the API at `http://localhost:3001`. Ports must be configurable; print effective URLs and fail clearly on port conflicts. Support Windows, macOS, and Linux without shell-specific startup commands. Docker, AWS credentials, AWS CLI, a GitHub login, and paid services are not required. After dependency installation, local play must work without internet using the packaged dictionary.

Use SQLite for durable local storage behind the same repository interfaces as DynamoDB. Store development data in a gitignored `.local/` directory. Implement revision checks, seat claims, state/history writes, and idempotency records atomically in SQLite transactions. Local and AWS transports must call the same application services, rules engine, dictionary, validation, and authorization logic. Do not implement separate local rules or bypass authentication.

A local background bot worker polls committed state for pending bot turns and invokes the same bot logic and expected-revision checks used in AWS. Bots continue with browsers closed while the server runs. Restarting services preserves games and resumes pending bot turns without duplicate moves. Nothing progresses while the local server is stopped.

Generate local invite links from the configured frontend origin, for example `http://localhost:5173/#/join/<inviteToken>`. Use separate browsers, profiles, or isolated browser automation contexts for different players; ordinary tabs share local storage and therefore the same seat. Localhost invitations work on the host computer. Cross-device LAN hosting is outside the required scope. Bind services to loopback by default, allow exact local CORS origins, and retain token redaction. HTTP is permitted for loopback development; production requires HTTPS.

Provide `.env.example` documenting `APP_MODE=local`, frontend/API origins, database path, and optional development seed. Local mode is the default for `npm run dev` and must never fall back to AWS when configuration fails. Production rejects development-only settings. Deterministic seeds affect board generation and bot testing, never credential generation.

| Root command | Required behavior |
|---|---|
| `npm run dev` | Start frontend, API, and bot worker; Ctrl+C stops all child processes |
| `npm run local:reset -- --confirm` | Clear the development database only after verifying its path is inside `.local/`; refuse production mode |
| `npm run test:unit` | Run deterministic unit tests once without services or network |
| `npm run test:unit:watch` | Run unit tests interactively |
| `npm run test:coverage` | Run unit tests with reports and enforce coverage thresholds |
| `npm run test:integration` | Run local API/storage tests against an isolated temporary SQLite database |
| `npm run test:e2e:local` | Start an isolated local stack, run browser scenarios, and clean up processes/data |
| `npm run check` | Run type checks, lint, unit coverage, local integration tests, frontend build, and infrastructure synthesis |

Automated tests must not touch normal development games or AWS resources. The README must explain first launch, isolated player sessions, saved data, reset, port overrides, and shutdown. Mocked UI fixtures do not satisfy localhost mode.

### Repository boundaries

```
apps/web/                 screens, accessibility, API client
services/api/             HTTP handlers, auth, persistence
services/bot-worker/      turn orchestration and recovery
services/local/           local HTTP bootstrap and bot runner
packages/storage/         repository interfaces, SQLite and DynamoDB adapters
packages/contracts/       schemas, DTOs, stable error codes
packages/game-engine/     pure rules, generator, scores
packages/dictionary/      pinned data, extraction, word search
infra/                    CDK stacks and deployment outputs
tests/e2e/                multi-browser scenarios
docs/                     spec, decisions, runbooks
.github/workflows/        CI and deployment
```

Engine and dictionary code must not import UI or AWS modules. API and bot worker must call the same engine. Contract changes require the integration owner's review before parallel consumers change.

## 8. State and API contracts

Game state: `id`, `schemaVersion`, `rulesVersion`, `dictionaryVersion`, `generatorVersion`, `seed`, `status` (lobby/active/finished), `revision`, `boardSize`, `seats`, `tiles`, `currentSeatIndex`, `consecutivePasses`, `createdAt`, `updatedAt`, `expiresAt`, and optional `result` with end reason and winner IDs. A seat has `id`, `index`, `kind`, `displayName`, and occupied status. Ownership references stable seat IDs. Defense and score are derived, not independently editable.

Store history as separate ordered turn records, not an ever-growing game item. Each record contains turn number, actor, action type, optional word and ordered tile IDs, timestamp, and resulting revision. Fetch previously accepted words through a paginated query when validating; do not truncate history silently. Store invite hashes, session hashes, and idempotency records separately and never return them in public DTOs.

Every mutation accepts a UUID `requestId`; after creation, include `expectedRevision`. Idempotency is scoped to actor/game (create and join use their documented guest bootstrap scope). Retrying the identical request returns its original result; reusing the ID with a different payload returns conflict. Keep records for the game's lifetime.

| Endpoint | Purpose |
|---|---|
| `POST /games` | Create lobby and host seat using proposed guest credential |
| `POST /invites/resolve` | Validate invite; return limited join information |
| `POST /games/{id}/join` | Claim a human seat with invite and proposed guest credential |
| `GET /games/{id}` | Authenticated current snapshot and revision |
| `PATCH /games/{id}/lobby` | Host changes unstarted configuration |
| `POST /games/{id}/invite` | Host rotates invitation |
| `POST /games/{id}/start` | Host starts fully occupied game |
| `POST /games/{id}/actions` | Human submits `{type: word, tileIds}` or `{type: pass}` |
| `GET /games/{id}/history?cursor=...` | Paginated authenticated history |

Use `Authorization: Bearer` for seat credentials. Mutation responses contain accepted revision and current snapshot. Error body: `{code, message, currentRevision?}`. Stable codes include `INVALID_INPUT`, `UNAUTHORIZED`, `FORBIDDEN`, `INVITE_INVALID`, `GAME_FULL`, `GAME_EXPIRED`, `NOT_YOUR_TURN`, `STALE_REVISION`, `INVALID_WORD`, `WORD_ALREADY_USED`, `WORD_IS_PREFIX`, `GAME_FINISHED`, and `RATE_LIMITED`. Return suitable 400/401/403/404/409/410/422/429/5xx HTTP statuses. Clients act on codes, not message text. Serialize precise schemas and examples in OpenAPI before implementation branches diverge.

## 9. Persistence, operations, and deployment

Retain games for 30 days after the last accepted mutation, including finished games. Reads do not extend retention. On each mutation, extend associated session/invite/idempotency retention consistently or validate all such access against the parent game expiration. Explicitly check expiry in application code; DynamoDB TTL deletion is cleanup, not authorization. Remove history/auxiliary records with a cleanup job keyed by expired game. Do not delete active games during deploys.

Configure HTTPS, exact frontend-origin CORS, request size limits, API throttling, per-session mutation limits, structured logs with token redaction, and least-privilege IAM. Use a content security policy, no third-party scripts in v1, and no credential-bearing analytics. Unauthorized requests cannot read a game simply by knowing its ID. Anonymous create/join endpoints need rate limits and monitored cost ceilings; document that budget alarms notify rather than guarantee a hard spend cap.

CI runs clean install, type checking, lint, unit/integration tests, frontend build, and CDK synthesis. Pull requests cannot deploy production. Deploy from protected main with GitHub OIDC to scoped AWS roles, then deploy the Pages artifact configured with the correct repository base path and AWS API URL. No long-lived AWS keys in repository secrets. Use distinct development/production tables and configuration. Retain production data on stack removal and enable recovery/backups. Document rollback compatibility for schema, rules, and dictionary versions.

Provide `.env.example`, the complete localhost workflow in section 7, one-command validation, deployment/bootstrap commands, infrastructure outputs, bot-failure replay, cleanup, and rollback runbooks. Final smoke test must use the actual Pages URL from two browsers. No GitHub credentials belong in the browser.

## 10. Testing requirements and acceptance tests

### Unit testing — required

Use a shared unit-test configuration across the TypeScript workspace; select and pin the runner during scaffolding. Keep tests beside their modules as `*.test.ts` or `*.test.tsx`. Unit tests run without AWS, SQLite, HTTP servers, browser automation, or external network access. Component tests may use a simulated DOM. Inject repository doubles, clocks, and random sources at boundaries; assert public behavior rather than private implementation details.

Required unit coverage:

- Game engine: each board size and player count, validation, turn rotation, simultaneous captures, defense timing, scores, pass reset, ties, finished states, input immutability, and rejected actions leaving state unchanged.
- Generator/dictionary: seeded reproducibility, dimensions, character bounds, quality constraints, fallback behavior, normalization/filtering, repeated letters, and prefix direction. Use a small explicit dictionary fixture for most tests; separately validate fallback boards against the shipped dictionary artifact.
- Bot: legal candidate enumeration, controlled random selection including boundary values, duplicate-letter tile allocation, exhausted candidates, and computation errors versus legitimate passes.
- Application services: host/seat authorization, invite expiry/revocation, lobby constraints, request validation, idempotency conflicts, stale revisions, and retry decisions using repository doubles and fake time.
- Frontend: tile selection/removal, controls enabled by turn, error-code presentation, stale-state reconciliation, and selection preservation across polling. Prefer user-visible assertions to broad snapshots.

Use fixed fixtures, fake time, and injected randomness for reproducible results. Avoid real sleeps and probabilistic pass/fail assertions. Add regression tests for behavioral defects. Test invariants including unique tile IDs, valid owners, and summed scores equaling owned tiles. Actual concurrent-write guarantees must also be tested at the storage integration layer.

Enforce at least 90% line and branch coverage separately for the game engine and dictionary/bot decision logic, and at least 80% line and branch coverage for other hand-written application code in aggregate. Exclude generated code, dictionary data, declarations, and dependencies; document exclusions. Verify infrastructure/bootstrap glue with synthesis and integration tests. Coverage percentages do not replace named edge-case tests.

### Integration, end-to-end, and CI gates

Run the same repository contract suite against SQLite locally and DynamoDB in a designated AWS test environment before release. Include concurrent final-seat claims, atomic state/history commits, duplicate requests, and restart recovery. Test HTTP request/response schemas against OpenAPI through the local stack. Verify bot scheduling independently from word-selection unit tests.

Every pull request runs `npm run check` and local end-to-end smoke tests without cloud credentials, and publishes test/coverage reports. Failures and missed thresholds block merge. Before production release, run the complete acceptance suite below and AWS adapter/deployment checks using isolated test data. Local tests do not certify IAM, API Gateway, DynamoDB Streams, or other cloud wiring.

### Acceptance scenarios

1. Create and complete a game for each of the nine combinations of 2/3/4 seats and 5/6/7 board side length, using humans and bots across the suite.
2. A second browser joins via invite with no account. Two simultaneous claims of the last seat yield one success. Repeated join retries never create extra seats.
3. Non-hosts cannot alter/start the lobby; host cannot start with an empty human seat. Started/revoked invites admit no one.
4. Validate tile uniqueness, repeated-letter counts, nonadjacent selection, dictionary membership, reuse, prefix direction, and zero-capture legal words.
5. Test corner/edge/interior defense, diagonal irrelevance, three different opponents, simultaneous capture, and protection lost during a move.
6. Test full-board finish, all-player consecutive passes for 2/3/4 seats, pass reset, shared winners, and rejection after finish.
7. Two competing moves at one revision commit exactly one action. Lost-response retries return the original result with no extra turn/history entry.
8. Refresh retains the same seat and board; another seat's credentials cannot impersonate it. Invite credentials cannot submit moves.
9. A bot selects only legal words, can select any candidate with controlled RNG, uses distinct tiles, passes only when the candidate set is empty, and handles all board sizes. Do not use flaky statistical assertions.
10. Consecutive bots advance while no browsers are open. Duplicate events cause no duplicate turns; worker failure is recoverable through retries/recovery job.
11. Two visible browsers converge to an accepted move within five seconds under ordinary staging conditions. Stale tabs recover without silently replaying a different move.
12. Exercise keyboard-only play, screen-reader names/announcements, four-player non-color identifiers, 320px 7×7 layout, and current stable Chrome, Firefox, Safari, and Edge.
13. Expired games refuse access before TTL cleanup; malformed IDs/tokens and oversized requests fail safely. Logs contain no invite/session tokens.
14. CI passes from a clean checkout; deployed Pages assets and fragment invite URLs work under `/<repository>/`; AWS deployment can be reproduced from documented inputs.
15. From a clean checkout with dependencies installed, `npm run dev` starts a working game without cloud credentials or internet. Verify all board sizes, 2–4 seats, invitations across isolated browsers, and human/bot play.
16. Restart local services during a pending bot turn: board, history, credentials, revision, and idempotency persist; the bot resumes exactly once. Reset requires the confirmation flag and cannot target production or paths outside `.local/`.
17. Unit and coverage commands pass without services or network; a broken assertion or coverage regression fails the command and CI. Local integration/e2e tests use temporary data and leave normal local games intact.

## 11. Agent work packages and integration sequence

This section assigns future work; no implementation agents have been launched for this planning task.

| Package | Ownership and deliverables | Dependency |
|---|---|---|
| A — Integration/contracts | Workspace, OpenAPI/DTOs, fixtures, ADRs, shared unit-test configuration and CI gates; own cross-package integration | First |
| B — Rules | Pure reducer, defense/scoring, generator, deterministic fixtures and unit tests | A contracts; dictionary fixture interface |
| C — Dictionary/bot | Licensed pinned dictionary build, candidate enumeration, random selection, seeded tests | A contracts; integrate B validator |
| D — Backend | Guest/invite auth, lobby, API, transactions, SQLite/DynamoDB adapters, localhost bootstrap, bot scheduling/recovery, service unit tests | A; use B/C adapters until complete |
| E — Frontend | All screens, mocked-contract flows, responsive and accessible interaction, component unit tests | A; integrate D endpoints |
| F — Infrastructure/release | CDK, environments, OIDC, Pages deployment, alarms and runbooks | A; coordinate D resource interfaces |
| G — Verification | Unit-coverage review, adapter contract/race/security/e2e checks, localhost acceptance and release evidence | Begin fixture review after A; release after B–F |

Milestone 1: freeze schemas and rules fixtures; scaffold the one-command localhost stack and passing unit-test/coverage commands. Milestone 2: finish one vertical slice, two humans on a 5×5 board with persistent local storage and the first AWS adapter contract tests. Milestone 3: add 3–4 seats, all board sizes, bot automation, retries, and resume. Milestone 4: staging end-to-end/accessibility/race verification, then production deployment and smoke test.

Each package submits a focused branch/PR with tests and documentation. Do not modify another package's public contracts without the integration owner. Use mocks generated from the same schemas rather than inventing interfaces independently. The integration owner resolves disagreements using this specification and records changes in `docs/decisions/`.

Definition of done: repository contains all source, dictionary provenance, tests, infrastructure, and runbooks; unit tests and coverage gates pass; complete localhost mode and acceptance suite pass; deployed frontend and backend support a complete invited human/bot game; release notes record actual URLs, versions, known limitations, and operating inputs. A mock-only demo is not completion.

## 12. References and remaining deployment inputs

- [User-provided Letterpress overview](https://en.wikipedia.org/wiki/Letterpress_(video_game))
- [Official gameplay reference](https://www.letterpressapp.com/how-to-play.html)
- [GitHub Pages hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [AWS API Gateway and Lambda](https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway-tutorial.html)
- [DynamoDB expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.html)
- [Dictionary project](https://github.com/en-wl/wordlist/blob/v2/README.md)

Before production, supply GitHub repository owner/name/visibility, AWS account/region and budget recipient/amount, and final product name. Use original artwork and interface copy; provide source acknowledgments and dictionary notices. Exact dictionary licensing/extraction verification is a required deliverable of package C, not a claim that this planning task has completed it.

## Optional defense rules
At game creation, offer two independent off-by-default toggles: Permanent Defense (`rules.permanentDefense`) and Exclusive Defense (`rules.exclusiveDefense`). Permanent Defense latches protection when a tile is surrounded after a completed move; previously defended tiles remain protected despite loss of neighbors. Defense during a move uses the pre-move snapshot. Exclusive Defense rejects any word using another player's defended tile, while allowing use of one's own. Both rules apply to every human and bot, are persisted with the game, and cannot change after start. Missing options mean false for old games. Show enabled rules in the invitation, lobby and game; disable unavailable board tiles. Bot candidate words and tile choices must both exclude unavailable tiles.

## Approved hosted security requirements — September 26, 2026

These requirements supersede the account-free design for hosted play only. Localhost mode remains account-free and must not contact Cognito.

- **Approved users:** Use a dedicated Cognito user pool with administrator-created accounts and public self-registration disabled. A game invitation does not create or approve an account. Every hosted create, invitation resolve/join, snapshot, history and mutation request requires an approved user's access token. Password entry and first-login password changes occur on Cognito's hosted login page, not in the game.
- **OAuth:** Use a public client with no client secret, authorization-code grant and S256 PKCE. Validate unpredictable OAuth state, expire incomplete sign-ins after ten minutes, remove callback codes from the URL, and restore only a validated internal game/invite hash. Request `openid wordboogie/play`; API authorization requires the access-token scope `wordboogie/play`. Keep access tokens in tab session storage, with five-minute lifetime; do not persist ID or refresh tokens. Offer Sign in/Sign out. Preserve the game invitation through authentication. Reauthentication can use Cognito's existing browser session.
- **Authentication before database access:** API Gateway's JWT authorizer checks the configured Cognito issuer, public client audience and play scope before invoking game Lambda. Lambda defensively checks trusted authorizer claims (issuer/client, access-token type, subject, scope and expiration) before rate-limit or game/session/history database operations. Never decode an unverified request token to authorize access. Then check the game-specific credential and account ownership before reading game history. Trusted bot/cleanup workers use IAM and remain independent of browser authentication.
- **Seat ownership:** Retain opaque game credentials as a second authorization layer, sent in `X-Game-Token`; `Authorization: Bearer` carries the Cognito access token. Tie seat sessions to the Cognito subject. An approved user cannot use another account's seat credential. Partition browser saved seats by signed-in account. Existing unbound hosted sessions are not grandfathered into access; no hosted games have been deployed at this milestone.
- **Explicit routes:** Remove the `ANY /` and `ANY /{proxy+}` Lambda routes. Allow only GET `/health`, POST `/games`, POST `/invites/resolve`, GET `/games/{id}`, GET `/games/{id}/history`, POST `/games/{id}/join`, PATCH `/games/{id}/lobby`, POST `/games/{id}/invite`, POST `/games/{id}/start`, and POST `/games/{id}/actions`. Only `/health` is public, static and database-free. CORS preflight is handled by API Gateway without login or Lambda. Unknown paths/methods must not invoke Lambda. Lambda also rejects unknown paths defensively before database access.
- **Search indexing:** Include `<meta name="robots" content="noindex, nofollow">` in the HTML and `X-Robots-Tag: noindex, nofollow` on API responses. These discourage cooperative crawlers; they do not hide public JavaScript, enforce authentication or prevent malicious scans. Do not rely on robots.txt as access control.
- **Account lifecycle:** Operators approve users using Cognito AdminCreateUser, can disable accounts and invalidate sessions, and must protect their AWS admin access with MFA. API Gateway performs offline JWT validation; disabling a user or signing out does not instantly invalidate an already-issued access token. Residual access lasts at most its remaining five-minute lifetime. Immediate revocation would require an additional online authorization/revocation design.
- **Acceptance:** Verify no database calls for missing/invalid/expired/wrong-scope/wrong-client login claims; cross-account seat rejection; PKCE/state failure; invitation restoration; signed-out UI without game requests; logout and account-separated saved seats; explicit routes and admin-only user-pool settings; noindex in the published artifact. Exercise Cognito first-login and expired-token flows against the actual deployment before release. No publication is authorized by these implementation changes.
