import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {verifiedAccess} from './collaboration-fixtures';

vi.mock('../../apps/web/src/config',()=>({config:{apiBase:'/api/v1'}}));
vi.mock('../../apps/web/src/api/auth',()=>({
 AuthSession:class {user=null;restore=async()=>false;onClear=()=>{};},installNativeSessionBridge:()=>{},
}));
vi.mock('../../apps/web/src/api/feishu-ui',()=>({installFeishuLogin:()=>({open:async()=>{}})}));
const reply=(data:any)=>new Response(JSON.stringify({code:0,data}),{status:200,headers:{ETag:'"2"'}});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

async function setup(){
 const capability=deferred<Response>(),queried=deferred<void>();
 const transport=vi.fn(async(input:any,init:any)=>{
  const path=String(input);
  if(path==='/api/v1/projects/p/snapshot')return reply({projectId:'p',revision:2,graph:JSON.parse(init.body).graph,updatedAt:'2026-10-06T00:00:00Z'});
  if(path==='/api/v2/conversations/c')return reply({id:'c',kind:'CANVAS',projectId:'p',revision:1});
  if(path.startsWith('/api/v2/model-capabilities?')){queried.resolve();return capability.promise;}
  throw new Error('unexpected write after canvas scope changed: '+path+' '+init.method);
 });
 vi.stubGlobal('location',{pathname:'/projects/',search:'',hash:''});
 vi.stubGlobal('window',{fetch:transport,setTimeout,addEventListener:vi.fn()});
 vi.stubGlobal('document',{addEventListener:vi.fn()});
 const {serviceRuntime:runtime}=await import('../../apps/web/src/service/runtime');
 runtime.api.setAccessToken('current-studio-user');runtime.storage.etags.set('p','"1"');
 runtime.auth.user={id:'owner'} as any;location.pathname='/project/canvas/p';
 runtime.storage.rememberAccess(verifiedAccess());runtime.storage.rememberAccess(verifiedAccess('q'));
 let notify!:()=>void;const graph={nodes:[],edges:[],meta:{name:'Draft'}};
 runtime.attachCanvas('p',{getRemoteData:()=>graph,subscribe:(callback:()=>void)=>{notify=callback;return()=>{};}});
 graph.meta.name='Unsaved edit';notify();
 const capabilities=()=>capability.resolve(reply({items:[{capabilityRef:'mock',version:'1',kind:'LLM',available:true,testMode:true,inputKinds:['TEXT'],outputKinds:['TEXT'],parameterSchemaVersion:'1'}],nextCursor:null}));
 return{runtime,transport,graph,notify,queried,capabilities};
}

it('rejects switching to another canvas while assistant model selection is pending',async()=>{
 const {runtime,transport,queried,capabilities}=await setup();
 const pending=runtime.assistant.start({session_id:'c',message:'continue'}),rejected=expect(pending).rejects.toMatchObject({code:'STALE_CANVAS_SESSION'});
 await queried.promise;
 location.pathname='/project/canvas/q';
 runtime.attachCanvas('q',{getRemoteData:()=>({nodes:[],edges:[]}),subscribe:()=>()=>{}});
 capabilities();await rejected;
 expect(transport.mock.calls.some(([path])=>String(path).endsWith('/messages')||String(path).endsWith('/runs'))).toBe(false);
});

it('rejects edits made after the first save while assistant model selection is pending',async()=>{
 const {runtime,transport,graph,notify,queried,capabilities}=await setup();
 const pending=runtime.assistant.start({session_id:'c',message:'continue'}),rejected=expect(pending).rejects.toThrow('当前画布尚未保存');
 await queried.promise;graph.meta.name='New unsaved edit';notify();capabilities();await rejected;
 expect(transport.mock.calls.some(([path])=>String(path).endsWith('/messages')||String(path).endsWith('/runs'))).toBe(false);
});
