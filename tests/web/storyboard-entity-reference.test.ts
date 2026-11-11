import {expect,it,vi} from 'vitest';
import {assertStoryboardEntityReferenceModel,storyboardEntityReference,wrapStoryboardEntityReference} from '../../apps/web/src/service/storyboard-entity-reference';
import {decodeGraph,encodeGraph} from '../../apps/web/src/service/graph';

function selection(){
 const node={id:'role',type:'rh-entity',position:{x:0,y:0},data:{storyboardEntityNode:true,storyboardScriptNodeId:'script',storyboardEntityKind:'character',entityId:'lin',status:'finished',imageUrl:'rhtv-asset:ast_generated',output:[{assetId:'ast_generated'}]} as any},graph={nodes:[node],edges:[]};
 const manager={getRemoteData:()=>graph,patchNodeData:vi.fn((_id:string,patch:any)=>Object.assign(node.data,patch)),flushOperationQueue:vi.fn()},identity={id:'owner'},runtime={auth:{user:identity as any},inspect:()=>({id:'p'}),storage:{encodeAsset:(value:string)=>value.replace('https://media.invalid/owned','rhtv-asset:ast_user')}},native={bt:()=>manager,bq:{getState:()=>({isRead:false})}};
 const callback=vi.fn((value:any)=>{node.data.imageUrl=value.imageUrl;node.data.output=[];return 'original result';}),owner={projectId:'p',scriptId:'script',kind:'character',entityId:'lin'};
 return {node,graph,manager,runtime,native,callback,owner,wrap:()=>wrapStoryboardEntityReference(runtime,native,owner,callback,v=>v.imageUrl)};
}

it('does not treat an ordinary generated preview as an explicit reference',()=>{
 const s=selection();expect(storyboardEntityReference(s.node.data)).toBe('');expect(s.manager.patchNodeData).not.toHaveBeenCalled();
});

it('persists only an explicit owned selection, including the user deliberately reselecting the same last generated asset',()=>{
 const s=selection(),pick=s.wrap();expect(pick({imageUrl:'rhtv-asset:ast_generated'})).toBe('original result');expect(s.callback).toHaveBeenCalledOnce();expect(storyboardEntityReference(s.node.data)).toBe('rhtv-asset:ast_generated');
 const restored=decodeGraph(encodeGraph(s.graph)).nodes[0].data;expect(storyboardEntityReference(restored)).toBe('rhtv-asset:ast_generated');
 // A new completed generation changes its preview; the explicitly fixed source remains the old asset.
 s.node.data.imageUrl='rhtv-asset:ast_later_generated';expect(storyboardEntityReference(s.node.data)).toBe('');
});

it('compares canonical owned asset identities when signed display URLs change',()=>{
 const s=selection();s.wrap()({imageUrl:'https://media.invalid/owned'});s.node.data.imageUrl='rhtv-asset:ast_user';expect(storyboardEntityReference(s.node.data,s.runtime.storage.encodeAsset)).toBe('rhtv-asset:ast_user');
});

it('flushes only the completed native selection queue before checking its actual chosen asset',()=>{
 const s=selection();let queued:any;s.callback.mockImplementation(value=>{queued={imageUrl:value.imageUrl,output:[]};return 'queued native choice';});s.manager.flushOperationQueue.mockImplementation(()=>{if(queued){Object.assign(s.node.data,queued);queued=undefined;}});
 expect(s.wrap()({imageUrl:'rhtv-asset:ast_native_queued'})).toBe('queued native choice');expect(s.node.data.imageUrl).toBe('rhtv-asset:ast_native_queued');expect(storyboardEntityReference(s.node.data)).toBe('rhtv-asset:ast_native_queued');expect(s.manager.flushOperationQueue).toHaveBeenCalledTimes(2);
});

it.each(['https://external.invalid/picture.png','blob:preview',''])('does not persist unresolved/external upload sources: %s',imageUrl=>{
 const s=selection();s.wrap()({imageUrl});expect(s.callback).toHaveBeenCalledOnce();expect(s.manager.patchNodeData).not.toHaveBeenCalled();
});

it.each(['project','owner','node','kind','asset','readOnly','running'])('does not attach the captured reference across a changed %s',async changed=>{
 const s=selection();let finish!:(value:any)=>void;s.callback.mockImplementation((value:any)=>{s.node.data.imageUrl=value.imageUrl;return new Promise(resolve=>finish=resolve) as any;});const pending=s.wrap()({imageUrl:'rhtv-asset:ast_user'});
 if(changed==='project')s.runtime.inspect=()=>({id:'other'});if(changed==='owner')s.runtime.auth.user={id:'other'};if(changed==='node')s.node.id='replacement';if(changed==='kind')s.node.data.storyboardEntityKind='scene';if(changed==='asset')s.node.data.imageUrl='rhtv-asset:ast_changed';if(changed==='readOnly')s.native.bq.getState=()=>({isRead:true});if(changed==='running')s.node.data.status='running';
 finish('original result');await pending;expect(s.manager.patchNodeData).not.toHaveBeenCalled();
});

it('does not mark a rejected native selection promise',async()=>{
 const s=selection();s.callback.mockRejectedValueOnce(new Error('upload failed') as never);await expect(s.wrap()({imageUrl:'rhtv-asset:ast_user'})).rejects.toThrow('upload failed');expect(s.manager.patchNodeData).not.toHaveBeenCalled();
});

it('rejects explicit real model/input mismatches rather than substituting another model',()=>{
 expect(()=>assertStoryboardEntityReferenceModel({kind:'IMAGE_TO_IMAGE'},'','林遥')).toThrow('林遥');expect(()=>assertStoryboardEntityReferenceModel({kind:'TEXT_TO_IMAGE'},'rhtv-asset:ast_user','林遥')).toThrow('参考图编辑模型');expect(()=>assertStoryboardEntityReferenceModel({kind:'IMAGE_TO_IMAGE'},'rhtv-asset:ast_user','林遥')).not.toThrow();expect(()=>assertStoryboardEntityReferenceModel({kind:'TEXT_TO_IMAGE'},'','林遥')).not.toThrow();
});
