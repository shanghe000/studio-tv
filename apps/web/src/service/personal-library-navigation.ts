import type {LibraryNavigate} from './library-navigation';

const path='/projects/canvas/assetLibrary';
export const isPersonalLibraryPath=(pathname?:string)=>pathname?.replace(/\/+$/,'')===path;
export function personalLibraryPath(search:string){
 const value=new URLSearchParams(search).get('libraryPath');if(!value)return[];
 const ids=value.split(',');return ids.length<=2&&ids.every(id=>/^[A-Za-z0-9_-]{1,200}$/.test(id))?ids:[];
}
export function personalLibraryURL(ids:string[],dialog=false){
 const query=new URLSearchParams();if(ids.length)query.set('libraryPath',ids.join(','));if(dialog)query.set('libraryDialog','create-folder');return path+(query.size?'?'+query:'');
}
/** The immutable page workspace exposes folder/open/back and create-dialog
 * callbacks. Reuse those callbacks; no hook offsets or native state mutation. */
export function installPersonalLibraryNavigation(native:any,runtime:any,router:()=>any){
 const jsx=native.j,react=native.r;if(!jsx||!react?.useEffect||!react?.cloneElement)return()=>{};
 const components=new WeakMap<Function,Function>(),installed:Array<{key:string;original:Function;wrapper:Function}>=[];
 const wrap=(Component:any)=>{
  let Wrapped=components.get(Component);if(Wrapped)return Wrapped;
  Wrapped=function PersonalLibraryNavigation(props:any){
   const location=native.ac(),actor=runtime.auth.user?.id,state=react.useRef({ids:[]as string[],loadingTarget:'',pageRequests:0,alive:true}),latest=react.useRef(null);
   const [warning,setWarning]=react.useState('');
   const tree=Component(props),found:{grid?:any;header?:any;create?:any;createModal?:any}={};
   const visit=(element:any):any=>{
    if(Array.isArray(element))return element.map(visit);
    if(!react.isValidElement(element))return element;
    let p=element.props,changes:any={};
    if(typeof p.onOpenFolder==='function'&&Array.isArray(p.items)&&typeof p.isRootLayer==='boolean'){
     found.grid=p;
     const open=(item:any,run:()=>unknown)=>{if(!item?.isFolder||p.managing)return run();if(state.current.ids.length>=2)return;const ids=[...state.current.ids,String(item.id)];state.current.ids=ids;state.current.pageRequests=0;const result=run();move(personalLibraryURL(ids));return result;};
     changes.onOpenFolder=(item:any)=>open(item,()=>p.onOpenFolder(item));
     if(typeof p.onFolderAction==='function')changes.onFolderAction=(action:string,item:any,...rest:any[])=>action==='preview'&&item?.isFolder?open(item,()=>p.onFolderAction(action,item,...rest)):p.onFolderAction(action,item,...rest);
    }
    if(typeof p.onBack==='function'&&typeof p.onCreateFolder==='function'){
     found.header=p;changes.onBack=()=>{state.current.ids=state.current.ids.slice(0,-1);state.current.pageRequests=0;const result=p.onBack();move(personalLibraryURL(state.current.ids));return result;};
    }
    if(typeof p.onCreateFolder==='function'){
     found.create=p;changes.onCreateFolder=()=>{const parent=personalLibraryURL(state.current.ids);const result=p.onCreateFolder();move(personalLibraryURL(state.current.ids,true),{state:{studioPersonalModalParent:parent}});return result;};
    }
    if(typeof p.className==='string'&&p.className.includes('asset-library-create-folder-modal')&&typeof p.onCancel==='function'){
     found.createModal=p;changes.onCancel=()=>{p.onCancel();dismissCreate();};
     if(typeof p.onOk==='function')changes.onOk=async()=>{const result=await p.onOk();if(state.current.alive&&runtime.auth.user?.id===actor&&isPersonalLibraryPath(router()?.state.location.pathname))dismissCreate();return result;};
    }
    if(typeof p.onSwitchAssetType==='function')changes.onSwitchAssetType=(...args:any[])=>{state.current.ids=[];state.current.pageRequests=0;const result=p.onSwitchAssetType(...args);move(personalLibraryURL([]));return result;};
    if(p.children!==undefined)changes.children=visit(p.children);
    return Object.keys(changes).length?react.cloneElement(element,changes):element;
   };
   const move:LibraryNavigate=(to,options)=>{if(state.current.alive&&runtime.auth.user?.id===actor)void router()?.navigate(to,options);};
   const dismissCreate=()=>{const current=router()?.state.location;if(!isPersonalLibraryPath(current?.pathname)||new URLSearchParams(current.search).get('libraryDialog')!=='create-folder')return;const to=personalLibraryURL(personalLibraryPath(current.search));move(current.state?.studioPersonalModalParent===to?-1:to,current.state?.studioPersonalModalParent===to?undefined:{replace:true});};
   const result=visit(tree);latest.current=found;
   react.useEffect(()=>{state.current.alive=true;return()=>{state.current.alive=false;};},[]);
   react.useEffect(()=>{
    if(!state.current.alive||runtime.auth.user?.id!==actor||!isPersonalLibraryPath(location.pathname))return;
    const view=latest.current;if(!view?.grid||view.grid.loading||view.grid.loadingMore)return;
    if(!view.grid.items.length&&view.grid.hasMore&&!state.current.ids.length)return;
    const desired=personalLibraryPath(location.search),actual=state.current.ids;
    // Wait for the native root/folder render caused by the preceding callback.
    if(view.grid.isRootLayer!==(actual.length===0))return;
    const target=desired.join(',');if(state.current.loadingTarget!==target){state.current.loadingTarget=target;state.current.pageRequests=0;}
    let common=0;while(common<actual.length&&common<desired.length&&actual[common]===desired[common])common++;
    if(common<actual.length){if(view.header){state.current.ids=actual.slice(0,-1);void view.header.onBack();}return;}
    if(actual.length<desired.length){
     const item=view.grid.items.find((item:any)=>item.isFolder&&String(item.id)===desired[actual.length]);
     if(item){if(view.grid.managing){view.header?.onToggleManage?.();return;}state.current.ids=[...actual,String(item.id)];view.grid.onOpenFolder(item);return;}
     if(view.grid.hasMore&&state.current.pageRequests++<100){view.grid.onLoadMore?.();return;}
     // A deleted/inaccessible folder never falls through to a write at root.
     move(personalLibraryURL(actual),{replace:true});setWarning('该文件夹不存在或已被删除，已返回上一级。');return;
    }
    const create=new URLSearchParams(location.search).get('libraryDialog')==='create-folder';
    if(create&&!view.createModal?.open){if(view.grid.canCreateFolder)view.create?.onCreateFolder();else move(personalLibraryURL(actual),{replace:true});}
    else if(!create&&view.createModal?.open)view.createModal.onCancel();
   });
   return warning?react.createElement(react.Fragment,null,react.createElement('div',{'data-studio-collaboration':'',className:'studio-library-status',role:'status'},warning,react.createElement('button',{type:'button',onClick:()=>setWarning('')},'知道了')),result):result;
  };
  components.set(Component,Wrapped);return Wrapped;
 };
 for(const key of ['jsx','jsxs'])if(typeof jsx[key]==='function'){
  const original=jsx[key],wrapper=function(this:any,...args:any[]){if(typeof args[0]==='function'&&args[0].name==='nxt'&&args[1]?.mode==='page')args[0]=wrap(args[0]);return Reflect.apply(original,this,args);};jsx[key]=wrapper;installed.push({key,original,wrapper});
 }
 return()=>{for(const {key,original,wrapper}of installed)if(jsx[key]===wrapper)jsx[key]=original;};
}
