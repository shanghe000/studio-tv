import {existsSync,readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';

const source=readFileSync(new URL('../../tools/draft-rescue/export-open-page.js',import.meta.url),'utf8');
function fixture(uploading=false){
 const assetUrl='https://fixture.invalid/storage/assets/a?token=synthetic-signature',graph:any={nodes:[{id:'n',type:'rh-text',data:{text:'尚未同步的新描述',imageUrl:uploading?'blob:still-uploading':assetUrl,password:'must-not-be-exported'}}],edges:[]},base={nodes:[],edges:[]};
 const state={ack:{graph:base,revision:7},graph,pending:[{base,local:graph,initialEtag:'"7"',unknownBase:false}]},link:any={click:vi.fn(),remove:vi.fn()},blobs:Blob[]=[],observe=vi.fn(),flush=vi.fn(),write=vi.fn(),alert=vi.fn();
 const runtime={auth:{user:{id:'fixture-user'}},inspect:()=>({id:'fixture-project',graph}),canvasAttachment:()=>({client:{flushOperationQueue:flush}}),flush:write,storage:{drafts:new Map([['fixture-project',state]]),observeNativeDraft:observe,draft:()=>graph,encodeAsset:(value:string)=>value===assetUrl?'rhtv-asset:a':value}};
 class URLs extends URL{static createObjectURL(blob:Blob){blobs.push(blob);return'blob:backup';}static revokeObjectURL(){}}
 const scope={window:{__RHTV_SERVICE__:runtime},document:{createElement:()=>link,body:{append:vi.fn()}},URL:URLs,Blob,alert,setTimeout:vi.fn()};
 return{scope,blobs,link,observe,flush,write,alert,runtime};
}
it('keeps the maintenance exporter outside all public Web assets',()=>{
 expect(existsSync(new URL('../../apps/web/public/draft-rescue.html',import.meta.url))).toBe(false);expect(existsSync(new URL('../../apps/web/public/draft-rescue.js',import.meta.url))).toBe(false);const ui=readFileSync(new URL('../../apps/web/src/service/draft-recovery-ui.ts',import.meta.url),'utf8');expect(ui).not.toContain('draft-rescue');expect(ui).not.toContain('draftRecovery=');
});
it('exports an internal maintenance copy with retained edits without writing the server',async()=>{
 const f=fixture();runInNewContext(source,f.scope);expect(f.observe).toHaveBeenCalled();expect(f.flush).toHaveBeenCalledWith(true);expect(f.write).not.toHaveBeenCalled();expect(f.link.click).toHaveBeenCalledOnce();
 const text=await f.blobs[0].text(),backup=JSON.parse(text);expect(backup).toMatchObject({format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId:'fixture-user',projectId:'fixture-project',baseRevision:7});expect(backup.graph.nodes[0].data).toEqual({text:'尚未同步的新描述',imageUrl:'rhtv-asset:a'});expect(backup.pending[0].base).toEqual({nodes:[],edges:[]});expect(text).not.toContain('synthetic-signature');expect(text).not.toContain('must-not-be-exported');
});
it('preserves text around incomplete local uploads and explicitly marks media that must be uploaded again',async()=>{
 const f=fixture(true);runInNewContext(source,f.scope);expect(f.link.click).toHaveBeenCalledOnce();const backup=JSON.parse(await f.blobs[0].text());expect(backup.unresolvedMedia).toBeGreaterThan(0);expect(backup.graph.nodes[0].data.text).toBe('尚未同步的新描述');expect(backup.graph.nodes[0].data.imageUrl).toMatch(/^studiotv-unuploaded:/);expect(f.alert).toHaveBeenCalledWith(expect.stringContaining('恢复后需重新上传'));expect(f.write).not.toHaveBeenCalled();
});
it('does not read or export another page without a signed-in canvas identity',()=>{
 const f=fixture();f.scope.window.__RHTV_SERVICE__=undefined as any;runInNewContext(source,f.scope);expect(f.link.click).not.toHaveBeenCalled();expect(f.alert).toHaveBeenCalledWith(expect.stringContaining('原画布页面'));
});
it('includes native edits still in the autosave delay when old capture rejects an unfinished upload',async()=>{
 const f=fixture(true),state=f.runtime.storage.drafts.get('fixture-project')!;
 state.graph=structuredClone(state.graph);state.pending=structuredClone(state.pending);
 f.runtime.inspect().graph.nodes[0].data.text='最后一批尚未进入保存队列的文字';f.observe.mockImplementation(()=>{throw new Error('unfinished upload');});
 runInNewContext(source,f.scope);const backup=JSON.parse(await f.blobs[0].text());expect(backup.graph.nodes[0].data.text).toBe('最后一批尚未进入保存队列的文字');expect(backup.pending.at(-1).local.nodes[0].data.text).toBe('最后一批尚未进入保存队列的文字');expect(backup.unresolvedMedia).toBeGreaterThan(0);expect(f.write).not.toHaveBeenCalled();
});
