import {expect,it,vi} from 'vitest';
import {installNativeProjectAccess} from '../../apps/web/src/service/native-project-access';
import {installNativeTeamPolicy} from '../../apps/web/src/service/native-team-policy';
import {installCollaborationRoutes} from '../../apps/web/src/service/collaboration-ui';
import {resolveFeatures} from '../../apps/web/src/features/policy';

it('holds a viewer read flag against native temporary-editor restoration and updates it when permissions or route change',()=>{
 let editable=false,path='/project/canvas/shared',listener=()=>{},routeListener=()=>{},state:any;const subscribers=new Set<()=>void>(),set=(value:boolean)=>{state={...state,isRead:value};for(const notify of subscribers)notify();};state={isRead:false,setIsRead:set};
 const native={bq:{getState:()=>state,subscribe:(run:()=>void)=>{subscribers.add(run);return()=>subscribers.delete(run);}}},storage={canEdit:()=>editable,subscribeAccess:(run:()=>void)=>{listener=run;return vi.fn();}};
 const router={state:{location:{pathname:path}},subscribe:(run:()=>void)=>{routeListener=run;return vi.fn();}},root={firstElementChild:{},children:[]},doc={getElementById:()=>root},surface={location:{pathname:path},addEventListener:vi.fn(),removeEventListener:vi.fn()};
 const dispose=installNativeProjectAccess({storage},native,()=>[{router}],surface,doc);expect(state.isRead).toBe(true);set(false);expect(state.isRead).toBe(true);editable=true;listener();expect(state.isRead).toBe(false);editable=false;listener();expect(state.isRead).toBe(true);router.state.location.pathname='/projects/shared';routeListener();expect(state.isRead).toBe(false);dispose();expect(surface.removeEventListener).toHaveBeenCalledTimes(2);
});
it('keeps STUDIO asset-team selection separate from the signed-in personal account',async()=>{
 const oldLoad=vi.fn(),oldSwitch=vi.fn(),oldBalance=vi.fn(),listeners=new Set<()=>void>();let state:any={loadTeams:oldLoad,setCurrentTeamId:oldSwitch,refreshTeamSubjectBalance:oldBalance};const store={getState:()=>state,setState:(patch:any)=>state={...state,...patch}};
 const adapter={currentTeamId:null as string|null,nativeTeams:()=>[{teamId:'t',role:'EDITOR',isCurrent:adapter.currentTeamId==='t'}],loadTeams:vi.fn(async()=>{}),selectTeam:vi.fn(async(id:string|null)=>{adapter.currentTeamId=id;for(const run of listeners)run();}),subscribe:(run:()=>void)=>{listeners.add(run);return()=>listeners.delete(run);}};
 const dispose=installNativeTeamPolicy({kk:store},resolveFeatures(),adapter);await state.loadTeams();await state.setCurrentTeamId('t');expect(state).toMatchObject({currentTeamId:null,teamSubjectBalance:null,teams:[{teamId:'t',role:'EDITOR',isCurrent:false}]});expect(adapter.currentTeamId).toBe('t');await state.setCurrentTeamId(0);expect(state.currentTeamId).toBeNull();expect(await state.refreshTeamSubjectBalance()).toBeNull();expect(oldLoad).not.toHaveBeenCalled();expect(oldSwitch).not.toHaveBeenCalled();expect(oldBalance).not.toHaveBeenCalled();dispose();expect(state.loadTeams).toBe(oldLoad);expect(state.setCurrentTeamId).toBe(oldSwitch);
});
it('patches owned framework routes once and replaces only the cold deep-route entry, preserving future POP history',()=>{
 const parent:any={id:'projects-root',path:'/projects',children:[]},router={routes:[parent],state:{location:{pathname:'/projects/team-assets/t',search:'?folderId=f&panel=members',hash:'',state:{studioLibraryTrail:['/projects/team-assets/t?folderId=f']}}},patchRoutes:vi.fn((id:string,children:any[])=>{expect(id).toBe(parent.id);parent.children.push(...children);}),navigate:vi.fn()};const native={r:{useEffect:()=>{},createElement:(type:any)=>({type})}};
 expect(installCollaborationRoutes(router,native,{})).toBe(true);expect(parent.children.map((route:any)=>route.path)).toEqual(['shared','teams','team-assets/:teamId?']);expect(router.navigate).toHaveBeenCalledWith('/projects/team-assets/t?folderId=f&panel=members',{replace:true,state:router.state.location.state});router.state.location.pathname='/projects/shared';expect(installCollaborationRoutes(router,native,{})).toBe(true);expect(router.patchRoutes).toHaveBeenCalledOnce();
});
