import {expect,it,vi} from 'vitest';
import {resolveFeatures} from '../../apps/web/src/features/policy';
import {installNativeTeamPolicy} from '../../apps/web/src/service/native-team-policy';

function fixture(){
 const loadTeams=vi.fn(async()=>{throw new Error('unimplemented team query');});
 const teams=[{teamId:'existing',name:'Existing native state'}];
 let state:any={teams,currentTeamId:'existing',loading:false,loadTeams};
 const store={getState:()=>state,setState:(patch:any)=>{state={...state,...patch};}};
 return{native:{kk:store},store,teams,loadTeams};
}

it('skips only the disabled native background action without inventing or clearing team data',async()=>{
 const f=fixture(),dispose=installNativeTeamPolicy(f.native,resolveFeatures());
 expect(await f.store.getState().loadTeams()).toBeUndefined();
 expect(f.loadTeams).not.toHaveBeenCalled();expect(f.store.getState()).toMatchObject({teams:f.teams,currentTeamId:'existing',loading:false});
 expect(f.store.getState().teams).toBe(f.teams);dispose();expect(f.store.getState().loadTeams).toBe(f.loadTeams);
});

it('preserves enabled feature behavior and unknown native seams',()=>{
 for(const features of [resolveFeatures('external'),resolveFeatures('internal',{externalLinks:true})]){
  const f=fixture(),dispose=installNativeTeamPolicy(f.native,features);expect(f.store.getState().loadTeams).toBe(f.loadTeams);dispose();
 }
 expect(()=>installNativeTeamPolicy({},resolveFeatures())()).not.toThrow();
});

it('does not overwrite an action installed later when disposed',()=>{
 const f=fixture(),dispose=installNativeTeamPolicy(f.native,resolveFeatures()),newer=vi.fn();f.store.setState({loadTeams:newer});dispose();expect(f.store.getState().loadTeams).toBe(newer);
});
