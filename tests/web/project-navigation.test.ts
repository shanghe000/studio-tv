import {expect,it,vi} from 'vitest';
import {installNativeProjectFolderNavigation,installProjectFolderRouter} from '../../apps/web/src/service/project-navigation';

const origin='https://studio.test',path='/projects/canvas/me';
const folders=(ids:string[])=>new URLSearchParams({folderPath:JSON.stringify(ids.map(id=>({id,name:'Folder '+id})))}).toString();
function setup(initial='/projects/'){
 const element={type:function ProjectList(){},props:{mode:'me',original:true}},team={type:function ProjectList(){},props:{mode:'team'}};
 let position=0,keys=0,reference:any;
 const entry=(to:string,state:any,idx:number)=>{const url=new URL(to,origin);return{location:{pathname:url.pathname,search:url.search,hash:url.hash,key:'framework-'+keys++,state},browserState:{usr:state,key:'framework-'+(keys-1),idx}};};
 const entries=[entry(initial,null,0)];
 const router:any={routes:[{path:'/projects',children:[{path:'canvas/me',element},{path:'canvas/team',element:team},{path:'canvas/assetLibrary',element:{type:function AssetLibrary(){},props:{mode:'page'}}}]}],state:{location:entries[0].location,historyAction:'POP'},revalidate:vi.fn()};
 const navigate=vi.fn((to:any,options:any={})=>{
  if(typeof to==='number'){position=Math.max(0,Math.min(entries.length-1,position+to));router.state={location:entries[position].location,historyAction:'POP'};return Promise.resolve();}
  const current=new URL(router.state.location.pathname+router.state.location.search+router.state.location.hash,origin),url=typeof to==='string'?new URL(to,current):new URL((to.pathname??current.pathname)+(to.search??'')+(to.hash??''),origin);
  if(options.replace){entries[position]=entry(url.href,options.state??null,position);router.state={location:entries[position].location,historyAction:'REPLACE'};}
  else{entries.splice(position+1);position++;entries.push(entry(url.href,options.state??null,position));router.state={location:entries[position].location,historyAction:'PUSH'};}
  return Promise.resolve();
 });
 router.navigate=navigate;
 const native={r:{createElement:(type:any,props:any)=>({type,props}),cloneElement:(original:any,extra:any)=>({...original,...extra}),useRef:(value:any)=>reference??(reference={current:value})},ac:()=>router.state.location};
 const originalElements=router.routes[0].children.map((route:any)=>route.element),dispose=installProjectFolderRouter(router,native,origin);
 const render=()=>{const wrapped=router.routes[0].children[0].element;return wrapped.type(wrapped.props);};
 return{router,native,entries,navigate,dispose,render,element,originalElements};
}

it('lets the actual framework push root, parent and nested folder entries with intact state and indices',async()=>{
 const s=setup();await s.router.navigate(path,{state:{from:'home'}});const rootKey=s.router.state.location.key;
 const options={replace:true,fromRouteId:'projects-me',preventScrollReset:true,state:{selected:'saved'}};
 await s.router.navigate('?'+folders(['A']),options);const parent=s.render();await s.router.navigate('?'+folders(['A','B']),options);const nested=s.render();
 expect(s.navigate.mock.calls[1][1]).toEqual({...options,replace:false});expect(options.replace).toBe(true);
 expect(s.entries.map(row=>row.browserState.idx)).toEqual([0,1,2,3]);expect(new Set(s.entries.map(row=>row.browserState.key)).size).toBe(4);
 expect(s.entries[2].browserState.usr).toEqual(options.state);expect(s.entries[1].location.key).toBe(rootKey);expect(parent.type).toBe(s.element.type);expect(nested.props).toBe(s.element.props);expect(parent.key).not.toBe(nested.key);
 await s.router.navigate(-1);expect(s.router.state.location.search).toBe('?'+folders(['A']));expect(s.render().key).not.toBe(nested.key);
 await s.router.navigate(-1);expect(s.router.state.location.pathname).toBe(path);expect(s.router.state.location.search).toBe('');
 await s.router.navigate(1);expect(s.router.state.location.search).toBe('?'+folders(['A']));await s.router.navigate(1);expect(s.router.state.location.search).toBe('?'+folders(['A','B']));
 expect(s.router.revalidate).toHaveBeenCalledOnce();s.dispose();
});

it('remounts local breadcrumb and query state on query-only POP but keeps ordinary search edits mounted',async()=>{
 const s=setup(path+'?'+folders(['A'])+'&keyword=one'),initial=s.render();
 await s.router.navigate('?'+folders(['A'])+'&keyword=two',{replace:false});expect(s.render().key).toBe(initial.key);
 await s.router.navigate(-1);const restored=s.render();expect(restored.key).not.toBe(initial.key);expect(s.router.state.location.search).toContain('keyword=one');
 expect(s.render().key).toBe(restored.key);await s.router.navigate(1);expect(s.render().key).not.toBe(restored.key);s.dispose();
});

it('preserves replacements for sorting, search, canonicalization, renamed breadcrumbs and unrelated routes',async()=>{
 const s=setup(path+'?'+folders(['A']));
 for(const to of ['?'+folders(['A'])+'&sortBy=CREATE_TIME','?'+folders(['A'])+'&keyword=Saved','?folderPath='+encodeURIComponent(JSON.stringify([{id:'A',name:'Renamed'}])),'?folderPath=invalid','/projects/canvas/assetLibrary','https://other.test/projects/canvas/me?'+folders(['B'])]){
  const options={replace:true,state:{source:'native'}};await s.router.navigate(to,options);expect(s.navigate.mock.calls.at(-1)![1]).toBe(options);
 }
 s.dispose();
});

it('uses the framework push when returning to the folder root and preserves object-form navigation',async()=>{
 const s=setup(path+'?'+folders(['A'])),options={replace:true,relative:'path',state:{current:true}};
 await s.router.navigate({search:'?sortBy=FILE_SIZE',hash:'#list'},options);
 expect(s.navigate.mock.calls[0][1]).toEqual({...options,replace:false});expect(s.entries).toHaveLength(2);expect(s.router.state.location.search).toBe('?sortBy=FILE_SIZE');expect(s.router.state.location.hash).toBe('#list');s.dispose();
});

it('restores only the navigation and route wrappers it owns on disposal',()=>{
 const s=setup(path);expect(s.router.routes[0].children[0].element).not.toBe(s.originalElements[0]);expect(s.router.routes[0].children[1].element).not.toBe(s.originalElements[1]);expect(s.router.routes[0].children[2].element).toBe(s.originalElements[2]);
 s.dispose();expect(s.router.navigate).toBe(s.navigate);expect(s.router.routes[0].children.map((route:any)=>route.element)).toEqual(s.originalElements);
});

it('waits for the native RouterProvider props to mount and releases its observer on pagehide',()=>{
 const s=setup(path);s.dispose();let callback!:()=>void,hide!:(event:any)=>void;
 const disconnect=vi.fn(),observe=vi.fn(),surface={location:{origin},MutationObserver:class {constructor(fn:()=>void){callback=fn;}disconnect=disconnect;observe=observe;},addEventListener:vi.fn((_event:string,fn:(event:any)=>void)=>{hide=fn;}),removeEventListener:vi.fn()},root:any={firstElementChild:null,children:[]},doc={getElementById:()=>root},props=vi.fn((element:any)=>element?[{value:{router:s.router}}]:[]);
 const dispose=installNativeProjectFolderNavigation(s.native,props,surface,doc);expect(observe).toHaveBeenCalledWith(root,{childList:true,subtree:true});
 root.firstElementChild={};root.children=[root.firstElementChild];callback();expect(s.router.navigate).not.toBe(s.navigate);expect(disconnect).toHaveBeenCalledOnce();expect(s.router.revalidate).toHaveBeenCalledTimes(2);
 hide({persisted:true});expect(s.router.navigate).not.toBe(s.navigate);expect(surface.removeEventListener).not.toHaveBeenCalled();
 hide({persisted:false});expect(s.router.navigate).toBe(s.navigate);expect(surface.removeEventListener).toHaveBeenCalledWith('pagehide',hide);callback();expect(s.router.navigate).toBe(s.navigate);dispose();
});
