import {expect,it,vi} from 'vitest';
import {ExecutionAdapter} from '../../apps/web/src/service/execution';
import {ProductClient} from '../../apps/web/src/service/product-client';
import {ServiceStorage} from '../../apps/web/src/service/storage';

it('aborts local task watchers on detach without canceling accepted server jobs',async()=>{
 let signal!:AbortSignal;
 const transport=vi.fn((_path:string,options:any)=>new Promise<Response>((_resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}));
 const api=new ProductClient('/api/v1',transport);api.setAccessToken('owner');const notice=vi.fn(),storage=new ServiceStorage(api,notice),adapter=new ExecutionAdapter(api,storage,async()=>{},notice);
 const graph={nodes:[{id:'n',type:'rh-text',data:{taskId:'accepted_task',status:'processing'}}]},manager={getRemoteData:()=>graph};
 adapter.attach('p',manager);expect(transport).toHaveBeenCalledOnce();expect(signal.aborted).toBe(false);adapter.detach();expect(signal.aborted).toBe(true);
 await Promise.resolve();await Promise.resolve();expect(notice).not.toHaveBeenCalled();expect(graph.nodes[0].data).toEqual({taskId:'accepted_task',status:'processing'});expect(transport.mock.calls.map(call=>call[0])).toEqual(['/api/v2/tasks/accepted_task']);
 adapter.attach('p',manager);expect(transport).toHaveBeenCalledTimes(2);adapter.detach();adapter.clear();
});
