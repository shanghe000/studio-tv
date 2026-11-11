import {build,loadEnv} from 'vite';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeFrameShells,gateFrameShellHtml} from './frame-shell-html.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const env=loadEnv('production',root,''),runtimeMode=process.env.RHTV_MODE||env.RHTV_MODE||'service';
if(!['preview','service'].includes(runtimeMode))throw new Error('RHTV_MODE must be preview or service');
await build({configFile:false,build:{target:'es2022',emptyOutDir:false,outDir:join(root,'dist'),lib:{entry:join(root,'src/runtime/frame-runtime.js'),name:'RhtvFrame',formats:['iife'],fileName:()=> 'frame-runtime.js'}}});
await build({configFile:false,define:{__RHTV_BUILD_MODE__:JSON.stringify(runtimeMode)},build:{target:'es2022',emptyOutDir:false,outDir:join(root,'dist'),lib:{entry:join(root,'src/runtime/frame-shell-entry.ts'),name:'StudioFrameShell',formats:['iife'],fileName:()=> 'frame-shell-entry.js'}}});
// Rewrite copies of only these application shells. Native source files,
// module bytes and generated user work stay outside this transformation.
for(const shell of nativeFrameShells){const path=join(root,'dist',shell);await writeFile(path,gateFrameShellHtml(shell,await readFile(path,'utf8')));}
// Native deep routes use one compiled bootstrap. Embedded editors and the
// maintained standalone guide keep their own documents.
const rootHtml=await readFile(join(root,'dist/index.html'),'utf8');
const {readdir}=await import('node:fs/promises');
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name==='index.html'&&!path.includes('/opencut/')&&!path.includes('/labs/')&&!path.includes('/hyperframes-studio/')&&!path.includes('/guide/')&&path!==join(root,'dist/index.html'))await writeFile(path,rootHtml);}}
await walk(join(root,'dist'));
