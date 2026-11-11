import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it,vi} from 'vitest';
import {installNativeTextSelectionMenu} from '../../apps/web/src/service/native-text-selection-menu';

function surface(){
 const listeners=new Map<string,Function>(),anchor={},focus={},editor={matches:(value:string)=>value==='.rh-text-editor[contenteditable="true"]',contains:(node:any)=>node===anchor||node===focus},menu={},button={closest:(value:string)=>value==='.rh-text-selection-menu'?menu:null};
 const style={id:'',textContent:'',remove:vi.fn()},selection={anchorNode:anchor,focusNode:focus,isCollapsed:false},doc:any={head:{append:vi.fn()},createElement:()=>style,activeElement:editor,getSelection:()=>selection,addEventListener:(name:string,fn:Function,capture:boolean)=>{expect(capture).toBe(true);listeners.set(name,fn);},removeEventListener:(name:string,fn:Function,capture:boolean)=>{expect(capture).toBe(true);if(listeners.get(name)===fn)listeners.delete(name);}};
 const press=(values:any={})=>{const event={button:0,defaultPrevented:false,target:{closest:(value:string)=>value==='button.rh-text-selection-item'?button:null},preventDefault:vi.fn(function(this:any){this.defaultPrevented=true;}),stopPropagation:vi.fn(),...values};listeners.get('mousedown')?.(event);return event;};
 return{doc,style,selection,editor,press,listeners};
}
it('preserves selection only for the exact native menu and restores its owned hooks',()=>{
 const s=surface(),dispose=installNativeTextSelectionMenu(s.doc),event=s.press();expect(event.defaultPrevented).toBe(true);expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).not.toHaveBeenCalled();expect(s.style.textContent).toBe('.rh-text-selection-menu{z-index:50001}');dispose();expect(s.listeners.size).toBe(0);expect(s.style.remove).toHaveBeenCalledOnce();
});
it.each(['right-button','already-prevented','outside-menu','ordinary-button','different-editor','collapsed','foreign-anchor','foreign-focus'])('does not intercept unrelated or stale input: %s',change=>{
 const s=surface(),dispose=installNativeTextSelectionMenu(s.doc),values:any={};if(change==='right-button')values.button=2;if(change==='already-prevented')values.defaultPrevented=true;if(change==='outside-menu')values.target={closest:()=>({closest:()=>null})};if(change==='ordinary-button')values.target={closest:()=>null};if(change==='different-editor')s.doc.activeElement={matches:()=>false};if(change==='collapsed')s.selection.isCollapsed=true;if(change==='foreign-anchor')s.selection.anchorNode={};if(change==='foreign-focus')s.selection.focusNode={};const event=s.press(values);expect(event.preventDefault).not.toHaveBeenCalled();dispose();
});

it.each([false,true])('lets the immutable TFr/gFr click build nodes before blur only when focus is preserved: %s',installed=>{
 const frozen=readFileSync(new URL('../../apps/web/public/project/assets/index-DeyN_Phq.js',import.meta.url),'utf8'),slice=(start:string,end:string)=>{const a=frozen.indexOf(start),b=frozen.indexOf(end,a+start.length);if(a<0||b<0)throw new Error('Frozen selection-menu seam changed');return frozen.slice(a,b);},s=surface(),created:any[]=[],edges:any[]=[],source={id:'source',position:{x:0,y:0},data:{text:'full source',width:300,height:200}},editorRef={current:{}},selected='selected excerpt';let mounted=true,id=0;
 const jsx=(type:any,props:any)=>({type,props}),native=runInNewContext([slice('function gFr(','function yFr('),slice('function $R(','function Qte('),slice('function xFr(','function wFr('),slice('function TFr(','function NFr(')].join('\n')+';({editor:TFr,menu:gFr})',{
  It:()=>({t:(key:string,options:any)=>options?.defaultValue||key}),sn:{t:(_key:string,options:any)=>options.defaultValue},d:{useState:()=>[{x:0,y:0,text:selected},vi.fn()],useLayoutEffect:vi.fn(),useEffect:vi.fn()},cNe:vi.fn(),xa:()=>({getNode:()=>source,setNodes:vi.fn()}),gFr:undefined,c:{jsx,jsxs:jsx,Fragment:'fragment'},sr:{createPortal:(value:any)=>value,flushSync:(fn:Function)=>fn()},document:{body:{},querySelector:()=>null},A2:300,oR:200,mF:()=>selected,X2:()=>false,Vm:(value:any)=>value,Qte:(nodes:any[],links:any[])=>{created.push(...nodes);edges.push(...links);},ma:(type:string,position:any,options:any)=>({id:'new-'+(++id),type,position,data:{title:options.title,...options.data}}),
 });
 const tree=native.editor({nodeId:'source',editorRef,initialHtml:'full source',onMounted:vi.fn(),onCommit:()=>{mounted=false;}}),editor=tree.props.children[0],menuProps=tree.props.children[1].props,menu=native.menu(menuProps),imageButton=menu.props.children[1];
 const dispose=installed?installNativeTextSelectionMenu(s.doc):()=>{},event=s.press();if(!event.defaultPrevented)editor.props.onBlur();if(mounted)imageButton.props.onClick();
 if(installed){expect(created.map(node=>node.type)).toEqual(['rh-text','rh-image']);expect(created[0].data.text).toBe(selected);expect(edges.map(edge=>[edge.source,edge.target])).toEqual([['source','new-1'],['new-1','new-2']]);expect(mounted).toBe(true);}else{expect(mounted).toBe(false);expect(created).toHaveLength(0);}
 dispose();
});
