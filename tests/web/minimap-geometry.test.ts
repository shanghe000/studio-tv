import {describe,it,expect} from 'vitest';
import {
  isMinimapViewportPoint,minimapCenterViewport,minimapDragViewport,minimapPoint,
  type ScreenToFlowMatrix,type Viewport,
} from '../../apps/web/src/canvas/minimap-geometry';

const identity:ScreenToFlowMatrix={a:1,b:0,c:0,d:1,e:0,f:0};

describe('minimap navigation geometry',()=>{
  it('uses the SVG inverse CTM, including page offset, letterboxing and distinct axis scales',()=>{
    // Forward mapping: screenX=(worldX+600)/4+30, screenY=(worldY-100)/2+80.
    const inverse={a:4,b:0,c:0,d:2,e:-720,f:-60};
    expect(minimapPoint(inverse,{x:130,y:100})).toEqual({x:-200,y:140});
    expect(minimapPoint(inverse,{x:30,y:80})).toEqual({x:-600,y:100});
  });

  it('retains the full affine mapping for rotated or skewed SVG coordinates',()=>{
    const inverse={a:2,b:1,c:-1,d:3,e:40,f:-30};
    expect(minimapPoint(inverse,{x:20,y:10})).toEqual({x:70,y:20});
    expect(minimapDragViewport({x:0,y:0,zoom:2},{x:20,y:10},{x:30,y:15},inverse)).toEqual({x:-30,y:-50,zoom:2});
  });

  it.each([0.5,2])('drags the viewport rectangle by the pointer world delta at zoom %s',zoom=>{
    const start:Viewport={x:120,y:-40,zoom};
    const matrix={a:5,b:0,c:0,d:3,e:-400,f:500};
    const next=minimapDragViewport(start,{x:200,y:100},{x:224,y:82},matrix)!;
    expect(next).toEqual({x:120-120*zoom,y:-40+54*zoom,zoom});
    // The visible world's center follows the pointer; the main scene pans opposite to it.
    expect(-next.x/zoom-(-start.x/zoom)).toBeCloseTo(120);
    expect(-next.y/zoom-(-start.y/zoom)).toBeCloseTo(-54);
  });

  it('does not jump when grabbing off-center and returning to the initial pointer position',()=>{
    const start={x:-1600,y:800,zoom:0.5};
    const pointer={x:320,y:185};
    const matrix={a:12,b:0,c:0,d:12,e:-4500,f:-2000};
    expect(minimapDragViewport(start,pointer,pointer,matrix)).toEqual(start);
    expect(minimapDragViewport(start,pointer,{x:330,y:180},matrix)).toEqual({x:-1660,y:830,zoom:0.5});
    expect(minimapDragViewport(start,pointer,pointer,matrix)).toEqual(start);
  });

  it('ends at the same viewport regardless of intermediate events or changing minimap bounds',()=>{
    const start={x:101,y:-51,zoom:0.5};
    const pointer={x:9,y:11};
    const frozen={a:7,b:0.5,c:0.25,d:9,e:-700,f:300};
    const finalPointer={x:43,y:-21};
    const direct=minimapDragViewport(start,pointer,finalPointer,frozen);
    for(const eventCount of [1,4,40,400]){
      let result:Viewport|null=null;
      for(let i=1;i<=eventCount;i++){
        const current={x:pointer.x+(finalPointer.x-pointer.x)*i/eventCount,y:pointer.y+(finalPointer.y-pointer.y)*i/eventCount};
        result=minimapDragViewport(start,pointer,current,frozen);
      }
      expect(result).toEqual(direct);
    }
    // Translation changes when the minimap recenters; frozen gesture geometry remains authoritative.
    expect(minimapDragViewport(start,pointer,finalPointer,{...frozen,e:9000,f:-15000})).toEqual(direct);
    expect(direct).toEqual({x:-14,y:84.5,zoom:0.5});
  });

  it('computes deltas before adding large offsets so small drag movements retain precision',()=>{
    const matrix={...identity,e:1e20,f:-1e20};
    expect(minimapDragViewport({x:0,y:0,zoom:1},{x:20,y:30},{x:21,y:32},matrix)).toEqual({x:-1,y:-2,zoom:1});
  });

  it.each([0.5,2])('centers a clicked negative world point without changing zoom %s',zoom=>{
    const point={x:-600,y:250};
    const size={width:1200,height:800};
    const viewport=minimapCenterViewport(point,size,zoom)!;
    expect(viewport).toEqual({x:600+600*zoom,y:400-250*zoom,zoom});
    expect(viewport.x+point.x*zoom).toBe(size.width/2);
    expect(viewport.y+point.y*zoom).toBe(size.height/2);
  });

  it('recognizes every viewport boundary and rejects points immediately outside it',()=>{
    const viewport={x:100,y:-150,zoom:0.5};
    const size={width:400,height:300};
    for(const point of [{x:-200,y:300},{x:600,y:300},{x:-200,y:900},{x:600,y:900},{x:0,y:600}]){
      expect(isMinimapViewportPoint(point,viewport,size)).toBe(true);
    }
    for(const point of [{x:-200.001,y:600},{x:600.001,y:600},{x:0,y:299.999},{x:0,y:900.001}]){
      expect(isMinimapViewportPoint(point,viewport,size)).toBe(false);
    }
  });

  it('rejects unusable matrices, nonfinite pointers, and overflowing coordinates',()=>{
    for(const matrix of [{...identity,a:NaN},{...identity,f:Infinity},{...identity,d:0},{...identity,a:1e308,d:1e308}]){
      expect(minimapPoint(matrix,{x:1,y:2})).toBeNull();
      expect(minimapDragViewport({x:0,y:0,zoom:1},{x:0,y:0},{x:1,y:2},matrix)).toBeNull();
    }
    expect(minimapPoint(identity,{x:Infinity,y:0})).toBeNull();
    expect(minimapPoint({...identity,a:2},{x:1e308,y:0})).toBeNull();
    expect(minimapDragViewport({x:0,y:0,zoom:1},{x:0,y:NaN},{x:1,y:2},identity)).toBeNull();
    expect(minimapDragViewport({x:0,y:0,zoom:1},{x:0,y:0},{x:NaN,y:2},identity)).toBeNull();
    expect(minimapDragViewport({x:0,y:0,zoom:2},{x:0,y:0},{x:1e308,y:0},identity)).toBeNull();
  });

  it('rejects invalid viewport zoom, canvas sizes and click points',()=>{
    const size={width:100,height:80};
    for(const zoom of [0,-1,NaN,Infinity]){
      const viewport={x:0,y:0,zoom};
      expect(minimapDragViewport(viewport,{x:0,y:0},{x:1,y:2},identity)).toBeNull();
      expect(minimapCenterViewport({x:0,y:0},size,zoom)).toBeNull();
      expect(isMinimapViewportPoint({x:0,y:0},viewport,size)).toBe(false);
    }
    for(const badSize of [{width:0,height:80},{width:100,height:-1},{width:NaN,height:80},{width:100,height:Infinity}]){
      expect(minimapCenterViewport({x:0,y:0},badSize,1)).toBeNull();
      expect(isMinimapViewportPoint({x:0,y:0},{x:0,y:0,zoom:1},badSize)).toBe(false);
    }
    expect(minimapCenterViewport({x:NaN,y:0},size,1)).toBeNull();
    expect(minimapCenterViewport({x:1e308,y:0},size,2)).toBeNull();
    expect(isMinimapViewportPoint({x:Infinity,y:0},{x:0,y:0,zoom:1},size)).toBe(false);
    expect(isMinimapViewportPoint({x:0,y:0},{x:Infinity,y:0,zoom:1},size)).toBe(false);
    expect(isMinimapViewportPoint({x:0,y:0},{x:0,y:0,zoom:Number.MIN_VALUE},size)).toBe(false);
  });
});
