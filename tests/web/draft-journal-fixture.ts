import type {DraftStorage} from '../../apps/web/src/service/draft-journal';
export class MemoryDraftStorage implements DraftStorage {
 readonly rows=new Map<string,string>();fail=false;
 get length(){return this.rows.size;}
 key(index:number){return [...this.rows.keys()][index]??null;}
 getItem(key:string){return this.rows.get(key)??null;}
 setItem(key:string,value:string){if(this.fail)throw new DOMException('full','QuotaExceededError');this.rows.set(key,value);}
 removeItem(key:string){this.rows.delete(key);}
}
