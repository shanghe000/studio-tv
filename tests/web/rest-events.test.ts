import {afterEach,expect,it,vi} from 'vitest';
import {ServiceEventSource} from '../../apps/web/src/service/rest-events';
afterEach(()=>vi.restoreAllMocks());

it('projects persisted SSE event names, sequence ids and multiline data across byte boundaries',async()=>{
 const bytes=new TextEncoder(),stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes.encode('id: 7\r'));controller.enqueue(bytes.encode('\nevent: file-change\r\ndata: first\r\ndata: second\r\n\r\n'));controller.close();}});
 ServiceEventSource.connect=vi.fn().mockResolvedValue(new Response(stream,{headers:{'Content-Type':'text/event-stream'}}));
 const source=new ServiceEventSource('/studio-api/events'),events:MessageEvent[]=[];source.addEventListener('file-change',event=>events.push(event as MessageEvent));
 await vi.waitFor(()=>expect(source.readyState).toBe(ServiceEventSource.CLOSED));expect(events).toHaveLength(1);expect(events[0].data).toBe('first\nsecond');expect(events[0].lastEventId).toBe('7');
});

it('reports unavailable persisted protocols without issuing a fake open or message',async()=>{
 ServiceEventSource.connect=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'NOT_IMPLEMENTED'}}),{status:501,headers:{'Content-Type':'application/json'}}));
 const source=new ServiceEventSource('/studio-api/events'),open=vi.fn(),message=vi.fn(),error=vi.fn();source.onopen=open;source.onmessage=message;source.onerror=error;
 await vi.waitFor(()=>expect(error).toHaveBeenCalledOnce());expect(open).not.toHaveBeenCalled();expect(message).not.toHaveBeenCalled();expect(source.readyState).toBe(ServiceEventSource.CLOSED);
});

it('cancels a stream returned after close and never reopens the prior session',async()=>{
 let resolve!:(response:Response)=>void;const cancelled=vi.fn(),stream=new ReadableStream<Uint8Array>({cancel:cancelled});
 ServiceEventSource.connect=vi.fn().mockImplementation(()=>new Promise<Response>(done=>resolve=done));
 const source=new ServiceEventSource('/studio-api/events'),open=vi.fn(),error=vi.fn();source.onopen=open;source.onerror=error;source.close();resolve(new Response(stream,{headers:{'Content-Type':'text/event-stream'}}));
 await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledOnce());expect(source.readyState).toBe(ServiceEventSource.CLOSED);expect(open).not.toHaveBeenCalled();expect(error).not.toHaveBeenCalled();
});
