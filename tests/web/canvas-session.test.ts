import {expect,it,vi} from 'vitest';
import {ProductClient} from '../../apps/web/src/service/product-client';

const reply=()=>new Response(JSON.stringify({code:0,data:{}}));
it('binds snapshot and generation writes to their own canvas page without crossing projects',async()=>{
 const transport=vi.fn(async()=>reply()),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-session');api.setCanvasSession('project-a','page-a');
 await api.request('/projects/project-a/snapshot',{method:'PUT',body:{graph:{nodes:[],edges:[]}}});
 await api.requestV2('/canvas-runs',{method:'POST',body:{projectId:'project-a'}});
 await api.requestV2('/canvas-runs',{method:'POST',body:{projectId:'project-b'},headers:{'X-STUDIO-Canvas-Session':'page-a'}});
 await api.request('/projects/project-b/snapshot',{method:'PUT',body:{},headers:{'X-STUDIO-Canvas-Session':'page-a'}});
 expect(transport.mock.calls.map((args:any)=>new Headers(args[1].headers).get('X-STUDIO-Canvas-Session'))).toEqual(['page-a','page-a',null,null]);
});
it('uses the current page for canvas assistant mutations and fences it after a login clear',async()=>{
 const transport=vi.fn(async()=>reply()),api=new ProductClient('/api/v1',transport);api.setAccessToken('first-session');api.setCanvasSession('project-a','page-a');
 await api.requestV2('/assistant/conversations/conv/runs',{method:'POST',body:{message:'Synthetic protocol input'}});
 api.clearRequests();api.setAccessToken('second-session');
 await api.requestV2('/canvas-runs',{method:'POST',body:{projectId:'project-a'}});
 expect(new Headers((transport.mock.calls[0] as any)[1].headers).get('X-STUDIO-Canvas-Session')).toBe('page-a');expect(new Headers((transport.mock.calls[1] as any)[1].headers).get('X-STUDIO-Canvas-Session')).toBeNull();
});
it('removes only a departed project binding and rejects malformed page identifiers',async()=>{
 const transport=vi.fn(async()=>reply()),api=new ProductClient('/api/v1',transport);api.setAccessToken('fixture-session');api.setCanvasSession('project-a','page-a');api.setCanvasSession('project-b','page-b');api.setCanvasSession('project-a',null);
 await api.requestV2('/projects/project-a/canvas-commands',{method:'POST',body:{}});await api.requestV2('/projects/project-b/canvas-commands',{method:'POST',body:{}});
 expect(new Headers((transport.mock.calls[0] as any)[1].headers).get('X-STUDIO-Canvas-Session')).toBeNull();expect(new Headers((transport.mock.calls[1] as any)[1].headers).get('X-STUDIO-Canvas-Session')).toBe('page-b');expect(()=>api.setCanvasSession('project-b','https://invalid')).toThrowError(expect.objectContaining({code:'INVALID_CANVAS_SESSION'}));
});
