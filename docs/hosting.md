# Hosted deployment and operations

Status: implemented and tested locally; **not published or deployed**. Default region: **us-west-2**. No AWS resources are created by `npm run check`, builds, or tests. Local games are not uploaded or migrated.

## Architecture

- GitHub Pages serves `dist/web`, using relative asset URLs and hash routing so repository Pages paths work. The build embeds the API origin, full Pages base URL, a content security policy and a no-referrer policy. No credentials are included in the build.
- API Gateway HTTP API validates approved-user Cognito access tokens before invoking a Node.js 24 Lambda. Account-bound game-seat credentials and invites retain the game rules from localhost mode, including both defense options. CORS checks the Pages **origin**, while invitations retain its **repository path**.
- DynamoDB stores bounded game state, immutable per-turn records, hashed seat/invite lookups and bounded idempotency responses separately. Conditional transactions serialize human/bot moves, joins and retries. Snapshot responses contain the latest 100 turns plus `historyCount`; the UI can load earlier moves. Server word validation always considers the complete history.
- DynamoDB Streams starts the bot Lambda for state changes. Each invocation takes at most one valid turn; the resulting write schedules the next bot. Duplicate delivery and concurrent workers are safe. A five-minute EventBridge recovery job queries a sparse pending-bot index. Bots do not depend on an open browser.
- Games expire 30 days after their last accepted change. Expiry is checked immediately by the service; DynamoDB TTL later removes state and a stream worker cleans related history, sessions and lookups. A live parent prevents cleanup. Auxiliary records do not have independent TTLs that could prematurely invalidate a long-running game.
- The table is retained on stack removal/replacement and has point-in-time recovery. Logs retain 14 days. Error, stream-lag and dead-letter alarms publish to an SNS topic. Providing an email enables subscriptions and an account-wide monthly budget notification (default threshold $5, notification at 80%). Confirm the SNS subscription email.

This implementation uses an AWS SAM/CloudFormation JSON template rather than CDK. It keeps the existing JavaScript engine and frontend; a TypeScript/React rewrite is not required for hosting. The local SQLite adapter remains independent. Hosted runtime SDK versions are pinned in `services/hosted/package-lock.json`.

## Cost expectations

There are no always-running servers, NAT gateways, load balancers, provisioned Lambda instances, or purchased domains. The API uses request-based Lambda/API Gateway and on-demand DynamoDB. API Gateway throttles to 10 requests/sec with burst 20; mutations additionally have per-IP/per-seat minute limits. Lambda concurrency is capped at 5 API executions and 2 worker executions by default.

This is designed for a small private game, **not a promise of $0/month**. DynamoDB reads/writes, PITR, logs, alarms, S3 deployment artifacts, and traffic can be billable. In particular, on-demand DynamoDB requests are not the same as the legacy provisioned-capacity free allowance. New-account credits and legacy free-tier eligibility differ; check the account before deploying. Budget alerts notify and do not stop spending. Anonymous traffic can still incur API costs even when rejected. Review billing after the first few days; disable the API and worker when no longer needed.

References: [AWS Free Tier](https://aws.amazon.com/free/), [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/), [Lambda concurrency](https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html), [Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Build and verify without AWS

```sh
npm ci
npm ci --prefix services/hosted
npm run check
npm run build:hosted
npm run infra:generate
pip install cfn-lint==1.57.0
cfn-lint infra/template.json
```

Set `API_URL=https://your-api.execute-api.us-west-2.amazonaws.com`, `FRONTEND_URL=https://OWNER.github.io/REPOSITORY`, `AUTH_DOMAIN` to the stack’s AuthDomain output, and `AUTH_CLIENT_ID` to its AuthClientId output, then run `npm run build:web`. Use an HTTPS API origin with no path; FRONTEND_URL includes the Pages repository path. Deployment output supplies the actual API URL. The generated config is public, not a secret.

DynamoDB adapter tests use the real downloadable [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html). Start it on a loopback port, set `DYNAMODB_ENDPOINT=http://127.0.0.1:8000`, then run:

```sh
npm run test:dynamo
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:e2e:hosted
```

These commands refuse non-loopback endpoints and use dummy credentials and randomly named temporary tables. Hosted browser tests intercept the example HTTPS Pages/API origins locally, serve the actual built artifact, and call the real Lambda adapter against DynamoDB Local. They do not verify AWS IAM, API Gateway, stream delivery, or a live Pages deployment. The cloud smoke test below remains necessary when publication is authorized.

## One-time deployment setup (infrastructure as code)

The repository now defines both stacks:

- `infra/bootstrap.json` (generated by `node infra/bootstrap.mjs`): private encrypted artifact bucket, GitHub OIDC provider or reuse of an existing provider, GitHub deployment role, CloudFormation execution role, and an enforced permissions boundary for application runtime roles.
- `infra/template.json` (generated by `node infra/generate.mjs`): the game API, storage, Cognito, background workers and monitoring.

No individual bucket or IAM role needs to be created manually. The one-time bootstrap is deployed by a signed-in AWS administrator; subsequent application deployments use GitHub OIDC. The GitHub role trusts only `repo:ItCouldHaveBeenGreat/WordBoogie:environment:production`. Restrict that GitHub environment to the main branch before publishing. The role can deploy only the application stack and pass only its CloudFormation role. Runtime roles must carry the bootstrap permissions boundary, which limits them to game data, logs, streams and the failure queue.

Some provisioning permissions are necessarily wider than stack-name resource prefixes: API Gateway generated API IDs, Cognito generated pool IDs, Lambda event-source mappings and listing APIs. The CloudFormation execution role is a privileged provisioning identity; restrict access to the protected workflow. It does not carry AdministratorAccess. Validate effective IAM permissions during the first real deployment; template lint cannot simulate AWS service authorization.

### First publication from AWS CloudShell

1. Commit and push the bootstrap additions and the updated publication workflow to main. Confirm Local game checks and Hosted checks pass.
2. In GitHub Settings → Pages, select GitHub Actions as the source. Create the `production` environment and restrict deployment branches to `main`; also restrict `github-pages` to `main`.
3. Sign into the intended AWS account and open CloudShell. Clone the repository (or upload the repository files if it is private and CloudShell cannot authenticate to GitHub):

```sh
git clone https://github.com/ItCouldHaveBeenGreat/WordBoogie.git
cd WordBoogie
bash scripts/bootstrap-aws.sh
```

The script prints the current AWS identity, uses us-west-2, discovers an existing GitHub OIDC provider when present, deploys wordboogie-bootstrap, and prints stack outputs. Running it again updates the same stack. It does not deploy the game or publish Pages.

4. Add these **repository Actions variables** under Settings → Secrets and variables → Actions → Variables:

| Variable | Bootstrap output/value |
|---|---|
| AWS_ARTIFACT_BUCKET | ArtifactBucket |
| AWS_DEPLOY_ROLE_ARN | DeployRoleArn |
| AWS_CFN_ROLE_ARN | CloudFormationRoleArn |
| AWS_RUNTIME_BOUNDARY_ARN | RuntimeBoundaryArn |
| FRONTEND_URL | https://itcouldhavebeengreat.github.io/WordBoogie |
| ALERT_EMAIL | Optional operations/budget email |

These identifiers are configuration, not access keys. No AWS access-key secrets are used. With the standard repository Pages URL above, there is no DNS or custom-domain step. If Pages shows a different URL, use that exact URL without a trailing slash.

5. Check the account Lambda concurrency quota. The application reserves five API and two bot executions; AWS must also retain its required unreserved pool. If a new account cannot accommodate this, request a quota increase or use `LimitConcurrency=false` in the application deployment command. The latter removes function concurrency caps; API/application throttles remain.
6. Run the manual publication workflow described below, then approve the first Cognito player accounts and complete the live smoke test.

For staging, use separate stack names, frontend configuration and LoginDomainPrefix. Customize the bootstrap repository/stack parameters and environment trust deliberately rather than reusing production roles. The artifact bucket and account OIDC provider are retained on bootstrap deletion. Do not delete the bootstrap stack while application roles depend on its boundary.

## Manual publication

When authorized, run **Publish hosted game (manual)** from the Actions tab on main. It runs checks, packages Lambda code to S3, deploys `wordboogie-production`, checks `/health`, builds with the resulting API URL, and publishes Pages. AWS and Pages jobs both use short-lived OIDC credentials. The backend cannot be reached from a Pages build that points at a different API origin; deploy them together.

Equivalent backend commands after building, with environment-specific values supplied:

```sh
aws cloudformation package --region us-west-2 --template-file infra/template.json --s3-bucket YOUR_ARTIFACT_BUCKET --s3-prefix wordboogie --output-template-file dist/packaged.json
aws cloudformation deploy --region us-west-2 --template-file dist/packaged.json --stack-name wordboogie-production --role-arn YOUR_CFN_ROLE_ARN --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameter-overrides RuntimePermissionsBoundaryArn=YOUR_RUNTIME_BOUNDARY_ARN FrontendUrl=https://OWNER.github.io/REPOSITORY AlertEmailAddress=YOUR_EMAIL MonthlyBudget=5 --no-fail-on-empty-changeset
```

Use a different stack name, Pages frontend, roles and bucket prefix for staging; never point test tools at the production table. Stack outputs identify the API URL, table, worker and dead-letter queue.

## Release smoke test

From the actual Pages URL, create a 3-player game with one bot and two humans in separate browser profiles/devices. Enable the optional rules. Share the invite, join, start, submit a valid word, and verify the bot proceeds after closing the submitting browser. Reopen to verify saved ownership, replay, history and turn order. Finish a two-human game by passing; verify both final screens. Try a rejected word and a stale request without losing a turn. Check CloudWatch for errors and confirm alarm emails. Record the actual URL and tested commit; local browser testing is not a substitute for this release gate.

## Recovery and rollback

- **Bot stuck:** inspect worker errors, iterator-age alarm and dead-letter queue. The scheduled recovery normally handles pending bots. For a specific game, invoke the worker with a JSON payload shaped like `{"Records":[{"eventName":"MODIFY","dynamodb":{"Keys":{"pk":{"S":"GAME#GAME_ID"},"sk":{"S":"STATE"}}}}]}`. Save it to a file and use `aws lambda invoke --function-name WORKER_OUTPUT --payload fileb://replay.json result.json`. It recomputes only a currently legal bot turn; duplicate invocations are safe.
- **Expired-game cleanup failed:** worker logs contain only operation and game ID, never credentials or request bodies. Reinvoke with `eventName: REMOVE` and the same key. Cleanup does nothing if the state still exists. Stream failure queue records may only contain batch metadata; use the structured log's game ID. A retry removes external lookups before removing their per-game references. Confirm cleanup before deleting the failure message. The automated recovery schedule retries bots, not missed cleanup; monitor the dead-letter alarm.
- **Roll back code:** redeploy a previously verified commit and its pinned dictionary, then republish its frontend against the same API. Do not roll back across incompatible schema/rules/dictionary versions. Existing game state records its versions; this release supports the bundled SCOWL version and territory-2 rules. Future incompatible updates need explicit migration/version routing.
- **Restore data:** restore the retained DynamoDB table to a new table with PITR, then update the stack/function configuration and stream source through a reviewed migration. Do not overwrite the live table in place. Retention also means deleting the stack does not erase game data or stop retained-table storage charges.
- **Stop service:** disable API access and the stream/scheduled worker triggers, or remove the application stack after preserving required backups. Explicitly handle the retained table, artifact bucket and logs separately. Do not use the localhost reset command on hosted data.

Known boundary: real AWS IAM/OIDC, stream scheduling, billing and live cross-device networking cannot be verified until an account and publication are authorized. No deployment has been attempted.

## Approved-user login — September 26, 2026

Hosted play now requires an administrator-created Cognito account. Self-registration is disabled. The static Pages shell remains public; signing in is required to call game APIs. Localhost remains account-free. The deployment template adds a dedicated user pool, resource scope, public OAuth client, hosted login domain and API Gateway JWT authorizer. Account identities are tied to game-seat credentials; invites do not bypass approval. Unknown HTTP paths/methods no longer have a Lambda integration, and invalid login claims are rejected before any database access (including rate limiting).

The Pages build now also requires `AUTH_DOMAIN` and `AUTH_CLIENT_ID`, obtained from stack outputs `AuthDomain` and `AuthClientId`. The manual publication workflow passes these automatically. For local build checks, use example HTTPS values, e.g. `AUTH_DOMAIN=https://login.example.com` and `AUTH_CLIENT_ID=exampleclient`. These identifiers are public configuration, not secrets. The deploy role's CloudFormation execution role must be allowed to manage this application's Cognito resources. LoginDomainPrefix defaults to `wordboogie` and is suffixed with account and region; use another prefix for staging in the same account/region. FrontendUrl must have no trailing slash; the registered callback/logout URI is FrontendUrl plus `/`.

After a future authorized deployment, get `UserPoolId` from the stack outputs and approve each player:

```sh
aws cognito-idp admin-create-user --region us-west-2 --user-pool-id USER_POOL_ID --username PLAYER_EMAIL --user-attributes Name=email,Value=PLAYER_EMAIL --desired-delivery-mediums EMAIL
```

Cognito sends a temporary-password invitation. The player opens WordBoogie, clicks Sign in, and completes Cognito's first-login password change. There is no shared site password, browser client secret, or self-service sign-up. Email delivery and the first-password-change UI must be checked in the live smoke test. Administrator access should use MFA and narrowly scoped permissions.

To remove approval, disable the user and invalidate their Cognito sessions:

```sh
aws cognito-idp admin-disable-user --region us-west-2 --user-pool-id USER_POOL_ID --username PLAYER_EMAIL
aws cognito-idp admin-user-global-sign-out --region us-west-2 --user-pool-id USER_POOL_ID --username PLAYER_EMAIL
```

These commands prevent continued sign-in/renewal; already-issued JWTs can remain usable at API Gateway until expiration. Access tokens last five minutes. The browser stores only the short-lived access token in session storage; no refresh token is retained. When it expires, Sign in resumes through Cognito (its existing login session may avoid another password prompt). Sign out clears local access and Cognito's login cookie; other active tabs/devices and copied access tokens may retain access until their token expires. Browser seat credentials remain account-separated and can be reused after signing in as the same account. Clearing browser storage still loses those credentials; account-based seat recovery is outside this change.

Public signup has no path in the application or user pool. Keep the user pool dedicated to approved players; do not enable federation or auto-provisioning without a corresponding approval policy. The pool is retained on stack deletion, like the game table. Do not delete it during code rollback.

The HTML `noindex, nofollow` directive and API `X-Robots-Tag` discourage indexing only. They are not protection from malicious scanning. A crawler must be able to fetch the HTML to observe the directive, so a robots.txt blanket disallow is deliberately not added.

Validation now covers PKCE/state, pre-database authentication rejection, account ownership, explicit routes and login/invite/logout browser flows. Hosted browser tests simulate Cognito and trusted gateway claims; they do **not** validate live AWS token signatures or email delivery. Those remain release checks. Sources: [AWS JWT authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html), [Cognito PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html).
