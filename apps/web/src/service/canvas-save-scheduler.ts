/** Short idle saves with a maximum wait: typing must not starve collaborators.
 * The caller keeps the durable draft and owns network/identity fencing. */
export class CanvasSaveScheduler {
 private timer:ReturnType<typeof setTimeout>|undefined;
 private since:number|undefined;
 private committedTurn?:object;
 constructor(private readonly run:()=>void,private readonly now=()=>Date.now()){}
 queue(){
  if(this.committedTurn)return;
  this.since??=this.now();if(this.timer!==undefined)clearTimeout(this.timer);
  this.timer=setTimeout(()=>{this.timer=undefined;this.since=undefined;this.run();},Math.min(150,Math.max(0,800-(this.now()-this.since))));
 }
 /** The native editor has already batched this transaction, and its operations
  * are in the durable outbox. Flush after all observers of this turn finish. */
 queueCommitted(){
  if(this.committedTurn)return;
  this.cancel();
  const turn={};
  this.committedTurn=turn;
  queueMicrotask(()=>{
   if(this.committedTurn!==turn)return;
   this.committedTurn=undefined;
   this.run();
  });
 }
 retry(delay:number){this.cancel();this.timer=setTimeout(()=>{this.timer=undefined;this.run();},delay);}
 cancel(){this.committedTurn=undefined;if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.since=undefined;}
}
