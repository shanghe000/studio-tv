import {expect,it} from 'vitest';
import {DraftJournal,parseDraftEnvelope,type DraftEnvelope} from '../../apps/web/src/service/draft-journal';
import {MemoryDraftStorage} from './draft-journal-fixture';
const graph=(text:string)=>({nodes:[{id:'a',type:'rh-text',position:{x:0,y:0},data:{text}}],edges:[]});
const envelope=(text='local'):DraftEnvelope=>({format:'STUDIOTV_CANVAS_DRAFT',schemaVersion:'1',userId:'user',projectId:'project',createdAt:'2026-11-02T00:00:00Z',updatedAt:'2026-11-02T00:00:00Z',baseRevision:1,base:graph('base'),graph:graph(text)});

it('isolates accounts, projects and page instances without overwriting another page backup',()=>{
 const storage=new MemoryDraftStorage(),a=new DraftJournal(()=>storage),b=new DraftJournal(()=>storage);
 a.write(envelope('page A'),'a');b.write(envelope('page B'),'b');
 expect(a.list('user','project').map(row=>row.graph.nodes[0].data.text).sort()).toEqual(['page A','page B']);
 expect(a.list('someone-else','project')).toEqual([]);expect(a.list('user','another-project')).toEqual([]);
 expect(()=>b.write(envelope('overwrite'),'a')).toThrow('另一个页面');
 b.removeOwn('user','project','a');expect(a.list('user','project')).toHaveLength(2);
});
it('marks only the consumed content version while keeping other-page records recoverable after newer edits',()=>{
 const storage=new MemoryDraftStorage(),a=new DraftJournal(()=>storage),b=new DraftJournal(()=>storage),row=a.write(envelope(),'a');
 b.markResolved(row);expect(b.list('user','project')).toEqual([]);expect(storage.rows.size).toBe(2);
 a.write(envelope('newer edit'),'a');expect(b.list('user','project')[0].graph.nodes[0].data.text).toBe('newer edit');
});
it('writes canonical metadata without credentials or signed URL queries',()=>{
 const storage=new MemoryDraftStorage(),journal=new DraftJournal(()=>storage),row=envelope();
 Object.assign(row.graph.nodes[0].data,{accessToken:'fixture-access',token:'fixture-token',authorization:'fixture-auth',imageUrl:'https://studio.invalid/asset?token=fixture-only&signature=synthetic'});
 journal.write(row,'one');const stored=[...storage.rows.values()][0];
 expect(stored).not.toContain('fixture-access');expect(stored).not.toContain('fixture-token');expect(stored).not.toContain('fixture-auth');expect(stored).not.toContain('?token=');expect(stored).not.toContain('synthetic');
 expect(journal.list('user','project')[0].graph.nodes[0].data.imageUrl).toBe('https://studio.invalid/asset');
});
it('leaves unavailable or corrupt storage explicit and refuses foreign identity imports',()=>{
 const storage=new MemoryDraftStorage(),journal=new DraftJournal(()=>storage);storage.fail=true;
 expect(()=>journal.write(envelope(),'one')).toThrow();
 expect(()=>parseDraftEnvelope(envelope(),'someone-else','project')).toThrow('账号');
 storage.fail=false;storage.setItem('studiotv:canvas-draft:v1:user:project:bad','not-json');
 expect(()=>journal.list('user','project')).toThrow();expect(storage.rows.size).toBe(1);
});
