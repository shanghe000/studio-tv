import {expect,it} from 'vitest';
import {generationReadinessPlacement} from '../../apps/web/src/service/native-generation-readiness';
const rect=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height});
for(const [name,viewport,anchor,contentHeight]of [
 ['desktop',{width:1512,height:756},rect(396,150,880,278),240],
 ['narrow',{width:390,height:844},rect(16,130,358,180),260],
 ['bottom-toolbar',{width:1100,height:800},rect(200,730,700,52),220],
 ['top-toolbar',{width:1100,height:800},rect(200,10,700,52),220],
 ['expanded-modal',{width:1100,height:800},rect(190,100,720,600),260],
 ['right-edge',{width:1100,height:800},rect(950,200,150,220),220],
 ['left-edge',{width:1100,height:800},rect(0,200,160,220),220],
 ['large-content',{width:390,height:844},rect(16,130,358,180),3000],
 ['zoomed',{width:550,height:400},rect(12,100,526,180),260]
]as const){
 it(`keeps the ${name} explanation inside the viewport and outside its native anchor`,()=>{
  const placement=generationReadinessPlacement(anchor,viewport,contentHeight);expect(placement).toBeDefined();if(!placement)return;
  const panel=rect(placement.left,placement.top,placement.width,Math.min(300,Math.max(60,contentHeight),placement.maxHeight));
  expect(panel.left).toBeGreaterThanOrEqual(12);expect(panel.top).toBeGreaterThanOrEqual(12);expect(panel.right).toBeLessThanOrEqual(viewport.width-12);expect(panel.bottom).toBeLessThanOrEqual(viewport.height-12);
  expect(panel.right<=anchor.left||panel.left>=anchor.right||panel.bottom<=anchor.top||panel.top>=anchor.bottom).toBe(true);
 });
}
it('leaves a fully occupied viewport to the caller to find a smaller controls anchor',()=>{
 expect(generationReadinessPlacement(rect(0,0,390,844),{width:390,height:844},200)).toBeUndefined();
});
