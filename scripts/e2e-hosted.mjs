import { spawnSync } from 'node:child_process';
const result=spawnSync(process.execPath,['--test','tests/dynamo.test.mjs'],{stdio:'inherit',env:{...process.env,HOSTED_BROWSER:'1'}});
process.exitCode=result.status??1;
