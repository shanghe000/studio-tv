import type {Features} from '../features/policy';

/** The inspected native team store exports loadTeams as a background action.
 * Disabled team controls must not start that unsupported query on personal
 * lists. Leave its existing data untouched; no team result is fabricated. */
export function installNativeTeamPolicy(native:any,features?:Pick<Features,'externalLinks'>,collaboration?:any){
 if(collaboration){
  const store=native.kk;if(typeof store?.getState!=='function'||typeof store?.setState!=='function')return()=>{};
  const initial=store.getState(),names=['loadTeams','setCurrentTeamId','reconcileStoredTeamId','refreshTeamSubjectBalance'],original=Object.fromEntries(names.map(name=>[name,initial[name]]));
  // STUDIO teams scope shared assets; browsing them must not switch the signed-in account.
  const project=()=>store.setState({teams:collaboration.nativeTeams().map((team:any)=>({...team,isCurrent:false})),currentTeamId:null,teamSubjectBalance:null});
  const actions={loadTeams:async()=>{store.setState({loading:true});try{await collaboration.loadTeams();project();}finally{store.setState({loading:false});}},setCurrentTeamId:async(id:any)=>{await collaboration.selectTeam(id&&String(id)!=='0'?String(id):null);project();},reconcileStoredTeamId:()=>false,refreshTeamSubjectBalance:async()=>null};
  store.setState(actions);project();const release=collaboration.subscribe(project);
  return()=>{release();const state=store.getState(),restore:any={};for(const name of names)if(state[name]===actions[name as keyof typeof actions])restore[name]=original[name];store.setState(restore);};
 }
 if(features?.externalLinks!==false)return()=>{};
 const store=native.kk;
 if(typeof store?.getState!=='function'||typeof store?.setState!=='function')return()=>{};
 const original=store.getState()?.loadTeams;
 if(typeof original!=='function')return()=>{};
 const skipped=async()=>{};
 store.setState({loadTeams:skipped});
 return()=>{if(store.getState()?.loadTeams===skipped)store.setState({loadTeams:original});};
}
