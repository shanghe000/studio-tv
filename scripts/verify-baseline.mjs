import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(), baseline=JSON.parse(await fs.readFile(path.join(root,'baseline/artifact-manifest.json'),'utf8'));
const nativePrefixes=['project/assets/','_nuxt/','opencut/assets/','hyperframes-studio/assets/'];
let checked=0;for(const [file,expected] of Object.entries(baseline.files)){if(!nativePrefixes.some(prefix=>file.startsWith(prefix)))continue;const actual=createHash('sha256').update(await fs.readFile(path.join(root,'apps/web/public',file))).digest('hex');if(actual!==expected)throw new Error('Native baseline changed: '+file);checked++;}
console.log(JSON.stringify({nativeAssetsVerified:checked,sourceCommit:baseline.sourceCommit}));
