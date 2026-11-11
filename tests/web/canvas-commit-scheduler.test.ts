import {afterEach,expect,it,vi} from 'vitest';
import {CanvasSaveScheduler} from '../../apps/web/src/service/canvas-save-scheduler';

afterEach(()=>vi.useRealTimers());

it('sends once after all observers finish an already recorded native transaction',async()=>{
 vi.useFakeTimers();
 const save=vi.fn();
 const scheduler=new CanvasSaveScheduler(save);
 for(let i=0;i<3;i++)scheduler.queueCommitted();
 expect(save).not.toHaveBeenCalled();
 await Promise.resolve();
 expect(save).toHaveBeenCalledTimes(1);
 expect(vi.getTimerCount()).toBe(0);
});

it('does not send an old project turn after detach or a fenced retry',async()=>{
 vi.useFakeTimers();
 const save=vi.fn();
 const scheduler=new CanvasSaveScheduler(save);
 scheduler.queueCommitted();
 scheduler.cancel();
 await Promise.resolve();
 expect(save).not.toHaveBeenCalled();
 scheduler.queueCommitted();
 scheduler.retry(1000);
 await Promise.resolve();
 expect(save).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1000);
 expect(save).toHaveBeenCalledTimes(1);
});
