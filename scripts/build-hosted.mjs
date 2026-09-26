import { mkdir, cp } from 'node:fs/promises';
await mkdir('dist/lambda/services/hosted',{recursive:true});
await mkdir('dist/lambda/packages',{recursive:true});
await cp('services/hosted','dist/lambda/services/hosted',{recursive:true});
await cp('packages/engine','dist/lambda/packages/engine',{recursive:true});
console.log('Lambda package built in dist/lambda');
