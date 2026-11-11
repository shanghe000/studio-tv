// @vitest-environment happy-dom
import {afterEach,expect,it} from 'vitest';
import {canvasFailureSnapshot,observeSnapshotDom} from '../../apps/web/src/service/canvas-failure-snapshot';

afterEach(()=>{document.body.replaceChildren();});

it('distinguishes a finished portrait graph from the actual busy HTML and button for that node',()=>{
 document.body.innerHTML=`<div class="react-flow__node draggable selected" data-id="portrait">
  <div class="rh-node-running-overlay"><button class="rh-node-generating-cancel">PRIVATE_LABEL</button></div>
  <img src="https://private.invalid/private.png?token=PRIVATE_SIGNATURE">
 </div>
 <div class="react-flow__node dragging" data-id="unrelated"><button class="generate-action-button"></button></div>
 <button id="action" class="generate-action-button" disabled aria-disabled="true"></button>`;
 const host=document.querySelector<HTMLElement>('[data-id="portrait"]')!;
 const graph={nodes:[{id:'portrait',type:'rh-image',data:{isPortraitAdjustResult:true,status:'finished'}}],edges:[]};
 const snap=canvasFailureSnapshot(graph,{control:'RETRY',targetId:'portrait',targetType:'NODE'})!;
 const visible=(el:HTMLElement)=>el.isConnected&&!el.closest('[hidden]');
 const action=document.getElementById('action')!;
 const dom=observeSnapshotDom(document,'portrait',action,visible,false,false);
 expect(snap.nodes[0]).toMatchObject({status:'finished',portraitResult:true});
 expect(dom).toEqual({host:true,draggable:true,dragging:false,selected:true,busyOverlay:true,cancelVisible:true,generateVisible:true,generateDisabled:true,controlAriaDisabled:true,readOnly:false,group:false});
 expect(JSON.stringify(dom)).not.toMatch(/PRIVATE|http/);
 host.querySelector<HTMLElement>('.rh-node-running-overlay')!.hidden=true;
 host.classList.remove('selected','draggable');
 expect(observeSnapshotDom(document,'portrait',undefined,visible)).toMatchObject({selected:false,draggable:false,busyOverlay:false,cancelVisible:false,generateVisible:false});
});

it('compares actual port configuration and incoming endpoints without exporting their values or IDs',()=>{
 const nodes=[{id:'target',type:'rh-image',data:{maxConnect:{image:null,text:null,video:null}}},{id:'PRIVATE_A',type:'rh-image',data:{}},{id:'PRIVATE_B',type:'rh-image',data:{}}];
 const mounted={nodes,edges:[{source:'PRIVATE_A',target:'target'},{source:'PRIVATE_B',target:'target'}]};
 const command={nodes:[{id:'target',type:'rh-image',data:{}},...nodes.slice(1)],edges:[{source:'PRIVATE_B',target:'target'}]};
 const intent={control:'COMMAND',targetId:'target',targetType:'NODE'} as const;
 const result=canvasFailureSnapshot(mounted,intent,command,mounted)!;
 expect(result.projection).toMatchObject({mountedMaxConnect:'ALL_NULL',commandMaxConnect:'ABSENT',mountedInputs:2,commandInputs:1,removedSources:1,addedSources:0});
 expect(JSON.stringify(result)).not.toContain('PRIVATE_');
 const limited={nodes:[{...nodes[0],data:{maxConnect:{image:1}}}],edges:[...mounted.edges].reverse()};
 expect(canvasFailureSnapshot(mounted,intent,limited,mounted)!.projection).toMatchObject({commandMaxConnect:'LIMITED',orderChanged:true,addedSources:0,removedSources:0});
});

it('describes the current declared native crop members, including a moved-out child with a stale pointer',()=>{
 const members=['a','b','c','d'];
 const group={id:'crop',type:'group',data:{nodeIds:[...members]}};
 const nodes=[group,...members.map(id=>({id,type:'rh-image',selected:true,data:{groupId:'crop',isUpload:true}}))];
 const g={nodes,edges:[]};
 const intent={targetType:'GROUP',control:'GROUP',targetId:'crop'} as const;
 expect(canvasFailureSnapshot(g,intent)!).toMatchObject({children:4,nodes:[{index:0},...members.map((_,i)=>({index:i+1,parent:0}))]});
 group.data.nodeIds.pop();
 const moved=canvasFailureSnapshot(g,intent)!;expect(moved.children).toBe(3);expect(moved.nodes[4]).toMatchObject({index:4,parentMismatch:true});expect(moved.nodes[4]).not.toHaveProperty('parent');
});
