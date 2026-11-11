const key='studiotv-bootstrap-recovery';

/** Old history documents can reference a lazy chunk removed by a release.
 * Retry the initial bootstrap once; no canvas has mounted at this point. */
export function recoverBootstrapChunk(error:unknown,surface:Pick<Window,'sessionStorage'|'location'>=window,canReload:()=>boolean=()=>false):boolean {
 const message=error instanceof Error?error.message:String(error);
 if(!/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message))return false;
 if(!canReload())return false;
 try{
  if(surface.sessionStorage.getItem(key)==='retried')return false;
  surface.sessionStorage.setItem(key,'retried');
  surface.location.reload();return true;
 }catch{return false;}
}

export function completeBootstrapRecovery(surface:Pick<Window,'sessionStorage'>=window){
 try{surface.sessionStorage.removeItem(key);}catch{/* Recovery is optional when tab storage is unavailable. */}
}
