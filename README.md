# WordBoogie

A multiplayer word-territory game: build words, claim tiles, and defend your corner of the board. Play with 2–4 humans/bots on a 5×5, 6×6, or 7×7 grid.

## Run locally

Install **Node.js 24 or newer** (with npm), then run from this repository:

```sh
npm ci
npm run dev
```

Open **http://localhost:5173**. No AWS account, Docker, or application dependencies are required. You can also start directly with `node scripts/dev.mjs`.

Create a game, choose the board size and seats, and start when all humans have joined. A bot-only opponent is the fastest way to try it. To invite another human on this computer, copy the lobby invite into a **different browser or browser profile**. Normal tabs share credentials and represent the same player. Localhost URLs do not reach another computer.

The server must stay running while you play. Bots run on the server even when browser windows close. Games persist in `.local/wordboogie.sqlite`; restart the server and reopen the same browser to resume. Clearing browser storage loses access to that guest seat. Ctrl+C stops both servers and the bot runner.

## Controls and rules

- Select letter tiles in any order; they do not have to touch. The word box reuses their ownership colors and protection markers. Drag word tiles with a mouse or touch to change their order. With a word tile focused, Alt+Left/Right reorders it, and Delete/Backspace removes it. Select a chosen board tile again to remove it; Clear empties the word.
- Submit a word to claim neutral and unprotected opponent tiles. Arrow keys navigate the board; Enter/Space selects tiles.
- A tile is defended when all its existing horizontal/vertical neighbors belong to its owner. It becomes a deeper, more saturated shade with a diamond marker, including in the word box. Defended opponent tiles can spell words but cannot be captured that turn. Stealing a surrounding neighbor removes its protection, making it capturable on a later turn.
- Previously played words are blocked for every player, even when using different matching tiles. Prefixes of previously played words are also blocked. Words must contain at least two letters and appear in the bundled dictionary.
- Pass when you want to skip a turn. The game ends when all tiles are owned or everyone passes consecutively. Most owned tiles wins; ties share the win.
- Bots choose a random legal word and randomly assign matching tiles, without strategic scoring.
- Dragged word tiles follow the mouse or finger, with the original position retained as a placeholder. Opponent moves replay with a word announcement and ordered tile highlights; reopening a game replays its latest action when another player made it. Passes show an announcement. Reduced-motion mode omits movement, and interacting with the board dismisses the replay.

## Configuration

Copy `.env.example` to `.env` if needed. `npm run dev` loads it automatically.

| Variable | Default |
|---|---|
| `APP_MODE` | `local` (no cloud fallback) |
| `FRONTEND_PORT` | `5173` |
| `API_PORT` | `3001` |
| `FRONTEND_ORIGIN` | `http://localhost:<FRONTEND_PORT>` |
| `DATABASE_PATH` | `.local/wordboogie.sqlite` |
| `DEV_SEED` | Random per game; set for repeatable board generation |

Both servers bind to loopback. If a port is occupied, change its variable. Keep the frontend origin consistent with the URL you open; the API enforces exact-origin CORS. After initial dependency installation, play works without internet.

To delete local games, **stop the server first**, then run:

```sh
npm run local:reset -- --confirm
```

Reset refuses production mode and database paths outside `.local/`. Saved browser entries for deleted games can be removed using browser storage settings.

## Test

```sh
npm run test:unit
npm run test:coverage
npm run test:integration
npm run check
```

Tests use Node's built-in test runner, deterministic fixtures, temporary SQLite databases, and no AWS resources. Unit tests need no running services. Coverage runs enforce 90% lines and branches for the engine and 80% for the API/frontend-model aggregate, using API integration tests for storage and HTTP behavior. DOM rendering is checked by the browser suite. `npm run test:unit:watch` supports interactive development. GitHub Actions runs local checks on Linux and Windows; browser scenarios also run on Linux.

Optional browser end-to-end tests use Playwright. Install it without changing the application's dependency manifest, install Chromium, and run:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:e2e:local
```

The browser suite starts isolated servers and a temporary database; it never resets ordinary saved games. `PLAYWRIGHT_MODULE` can point to an existing Playwright module entrypoint. `PLAYWRIGHT_EXECUTABLE_PATH` can select an installed compatible Chromium browser.

## Implementation scope

The game supports localhost play and a deployable hosted version: GitHub Pages, API Gateway/Lambda, DynamoDB, and background bots. Hosting code is implemented but **nothing has been published or deployed**. See [hosting setup and operations](docs/hosting.md) for builds, isolated cloud-adapter tests, manual deployment, costs and recovery. The target AWS region is us-west-2. Hosted play requires approved Cognito accounts; public sign-up is disabled. API authentication precedes database access, game seats are account-bound, and only explicit API routes are exposed. The site includes noindex directives to discourage search indexing; the Pages shell remains public. Localhost stays account-free. The bundled offline dictionary is SCOWL American English size 60: 78,659 words from release 2026.02.25, filtered for this game. It is not the official Letterpress dictionary. See its license, source pin, extraction settings, and rebuild instructions in `packages/engine/README.md`.

See [the specification](docs/specification.md) for the full product plan and [implementation decisions](docs/implementation-decisions.md) for milestone differences. Shared game rules live in `packages/engine`, local HTTP/persistence in `services/local`, hosted API/persistence in `services/hosted`, infrastructure in `infra`, and the browser interface in `apps/web`.
 

Optional defense rules can be selected independently when creating a game (both default off): **Permanent Defense** keeps a tile defended forever once it becomes surrounded, even after neighbors are captured. **Exclusive Defense** prevents other players from using defended tiles in words. Bots follow both rules. Rules are fixed once play starts and are shown in the lobby, invitation and game. Existing games retain standard defense.
