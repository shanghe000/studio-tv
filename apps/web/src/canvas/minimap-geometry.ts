export interface Point {x:number;y:number}
export interface Viewport extends Point {zoom:number}
export interface CanvasSize {width:number;height:number}

/** Inverse SVG screen CTM: browser client coordinates to canvas world coordinates. */
export interface ScreenToFlowMatrix {a:number;b:number;c:number;d:number;e:number;f:number}

function finite(...values:number[]):boolean {
  return values.every(Number.isFinite);
}

function validPoint(point:Point):boolean {
  return finite(point.x,point.y);
}

function validViewport(viewport:Viewport):boolean {
  return validPoint(viewport)&&Number.isFinite(viewport.zoom)&&viewport.zoom>0;
}

function validSize(size:CanvasSize):boolean {
  return finite(size.width,size.height)&&size.width>0&&size.height>0;
}

function validMatrix(matrix:ScreenToFlowMatrix):boolean {
  if(!finite(matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f))return false;
  const determinant=matrix.a*matrix.d-matrix.b*matrix.c;
  return Number.isFinite(determinant)&&determinant!==0;
}

export function minimapPoint(matrix:ScreenToFlowMatrix,screenPoint:Point):Point|null {
  if(!validMatrix(matrix)||!validPoint(screenPoint))return null;
  const point={x:matrix.a*screenPoint.x+matrix.c*screenPoint.y+matrix.e,y:matrix.b*screenPoint.x+matrix.d*screenPoint.y+matrix.f};
  return validPoint(point)?point:null;
}

/** Every move is measured from pointer-down using the same captured matrix and viewport. */
export function minimapDragViewport(startViewport:Viewport,startPointer:Point,currentPointer:Point,matrix:ScreenToFlowMatrix):Viewport|null {
  if(!validViewport(startViewport)||!validPoint(startPointer)||!validPoint(currentPointer)||!validMatrix(matrix))return null;
  const dx=currentPointer.x-startPointer.x;
  const dy=currentPointer.y-startPointer.y;
  const worldX=matrix.a*dx+matrix.c*dy;
  const worldY=matrix.b*dx+matrix.d*dy;
  const viewport={x:startViewport.x-worldX*startViewport.zoom,y:startViewport.y-worldY*startViewport.zoom,zoom:startViewport.zoom};
  return validViewport(viewport)?viewport:null;
}

export function minimapCenterViewport(point:Point,size:CanvasSize,zoom:number):Viewport|null {
  if(!validPoint(point)||!validSize(size)||!Number.isFinite(zoom)||zoom<=0)return null;
  const viewport={x:size.width/2-point.x*zoom,y:size.height/2-point.y*zoom,zoom};
  return validViewport(viewport)?viewport:null;
}

export function isMinimapViewportPoint(point:Point,startViewport:Viewport,size:CanvasSize):boolean {
  if(!validPoint(point)||!validViewport(startViewport)||!validSize(size))return false;
  const left=-startViewport.x/startViewport.zoom;
  const top=-startViewport.y/startViewport.zoom;
  const right=(size.width-startViewport.x)/startViewport.zoom;
  const bottom=(size.height-startViewport.y)/startViewport.zoom;
  if(!finite(left,top,right,bottom))return false;
  return point.x>=left&&point.x<=right&&point.y>=top&&point.y<=bottom;
}
