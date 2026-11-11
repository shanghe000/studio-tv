/** Library location and transient panels share the native router's history. */
export type LibraryNavigate = (to:string|number,options?:{replace?:boolean;state?:unknown})=>void;
export type LibraryLocation = {pathname:string;search?:string;state?:any};
const panelKeys=['panel','targetTeam','item','member'];
const origin='http://library.invalid';
const relative=(url:URL)=>url.pathname+url.search;
export function libraryBaseLocation(location:LibraryLocation){
 const url=new URL(location.pathname+(location.search??''),origin);
 for(const key of panelKeys)url.searchParams.delete(key);
 return relative(url);
}
export function teamLibraryURL(teamId?:string,folderId?:string|null,page=1){
 const url=new URL('/projects/team-assets'+(teamId?'/'+encodeURIComponent(teamId):''),origin);
 if(folderId)url.searchParams.set('folderId',folderId);
 if(page>1)url.searchParams.set('page',String(page));
 return relative(url);
}
export class LibraryNavigation {
 url:URL;
 private state:any;
 onChange:()=>void=()=>{};
 constructor(location:LibraryLocation,private readonly navigate:LibraryNavigate){
  this.url=new URL(location.pathname+(location.search??''),origin);this.state=location.state;
 }
 get base(){return libraryBaseLocation({pathname:this.url.pathname,search:this.url.search});}
 private trail():string[]{
  const values=this.state?.studioLibraryTrail;
  if(!Array.isArray(values)||values.length>12)return[];
  return values.every(value=>typeof value==='string'&&value.startsWith('/projects/team-assets')&&libraryBaseLocation(new URL(value,origin))===this.base)?values:[];
 }
 update(location:LibraryLocation){
  const next=new URL(location.pathname+(location.search??''),origin),changed=relative(next)!==relative(this.url);
  this.url=next;this.state=location.state;
  if(changed)this.onChange();
 }
 open(panel:string,values:Record<string,string>={}){
  const parent=relative(this.url),url=new URL(this.base,origin);
  url.searchParams.set('panel',panel);
  for(const [key,value]of Object.entries(values))if(panelKeys.includes(key)&&value)url.searchParams.set(key,value);
  if(relative(url)===parent)return;
  const state={studioLibraryTrail:[...this.trail(),parent]};
  this.update({pathname:url.pathname,search:url.search,state});
  this.navigate(relative(url),{state});
 }
 dismiss(targetPanel?:string){
  const trail=this.trail();let index=trail.length-1;if(targetPanel){while(index>=0&&new URL(trail[index],origin).searchParams.get('panel')!==targetPanel)index--;}
  const parent=index>=0?new URL(trail[index],origin):undefined,to=parent??new URL(this.base,origin);
  this.update({pathname:to.pathname,search:to.search,state:parent?{studioLibraryTrail:trail.slice(0,index)}:undefined});
  if(parent)this.navigate(-(trail.length-index));else this.navigate(relative(to),{replace:true});
 }
}
