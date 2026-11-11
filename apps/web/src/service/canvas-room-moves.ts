/** Negotiated representation of a position-only batch. JSON remains the
 * canonical operation for receipts, HTTP fallback and the durable outbox. */
export const moveFormat = 'move-v1';
const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const isRevision = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const optionalRevision = (n: unknown) => n === undefined || isRevision(n);
const isId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
const isCoordinate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const batchKeys = ['schemaVersion','batchId','clientId','observedRevision','baseRevision','receiptOnly','operations'];
const patchKeys = ['type','nodeId','set','unset'];
type Position = [id:string, x:number, y:number];
export interface RoomBinding {clientId:string; proof:string; lease:string}

function coordinate(field: unknown, axis: string) {
 if (!object(field) || !onlyKeys(field, ['path','value']) || !Array.isArray(field.path) ||
     field.path.length !== 2 || field.path[0] !== 'position' || field.path[1] !== axis || !isCoordinate(field.value)) return null;
 return field.value;
}

function position(op: unknown): Position | null {
 if (!object(op) || !onlyKeys(op, patchKeys) || op.type !== 'node.patch' || !isId(op.nodeId) ||
     !Array.isArray(op.set) || op.set.length !== 2 || !Array.isArray(op.unset) || op.unset.length) return null;
 const x = coordinate(op.set[0], 'x'), y = coordinate(op.set[1], 'y');
 return x === null || y === null ? null : [op.nodeId,x,y];
}

export function encodeRoomMoves(requestId: string, body: unknown, proof: string, lease: string, receiptBase?: number, pinned?:RoomBinding): {frame:Uint8Array<ArrayBuffer>;binding:RoomBinding;batchId:string} | null {
 if (!isId(requestId) || !/^[A-Za-z0-9_-]{32,96}$/.test(proof) || !/^[0-9a-f-]{36}$/i.test(lease) ||
     !object(body) || !onlyKeys(body, batchKeys) || body.schemaVersion !== '1' || !isId(body.clientId) || !isId(body.batchId) ||
     !optionalRevision(body.observedRevision) || !optionalRevision(body.baseRevision) || !optionalRevision(receiptBase) ||
     (body.receiptOnly !== undefined && typeof body.receiptOnly !== 'boolean') || !Array.isArray(body.operations) ||
     !body.operations.length || body.operations.length > 2048) return null;
 const rows: Position[] = [];
 for (const op of body.operations) {
  const row = position(op);
  if (!row) return null;
  rows.push(row);
 }
 const binding = {clientId:body.clientId,proof,lease};
 const reuse = pinned?.clientId === binding.clientId && pinned.proof === proof && pinned.lease === lease;
 const tuple = [requestId,body.batchId,reuse ? null : body.clientId,reuse ? null : proof,reuse ? null : lease,body.observedRevision ?? null,body.baseRevision ?? null,
  receiptBase ?? null,body.receiptOnly ?? false,rows];
 return {frame:utf8.encode('M'+JSON.stringify(tuple)),binding,batchId:body.batchId};
}

/** Reconstitute precisely the full canvas.delta envelope expected by the
 * normal cursor/graph/permissions validator. Invalid binary never advances a cursor. */
export function decodeRoomMoves(buffer: ArrayBuffer, projectId: string) {
 const bytes = new Uint8Array(buffer);
 if (bytes[0] !== 0x45) throw new TypeError('Invalid canvas position event');
 const tuple: unknown = JSON.parse(decoder.decode(bytes.subarray(1)));
 if (!Array.isArray(tuple) || tuple.length !== 7) throw new TypeError('Invalid canvas position envelope');
 const [cursor,fromRevision,graphRevision,updatedAt,nodeExecutionAvailable,nodeStates,rows] = tuple;
 if (typeof cursor !== 'string' || !/^[1-9]\d{0,18}$/.test(cursor) || !isRevision(fromRevision) ||
     !isRevision(graphRevision) || graphRevision <= fromRevision || typeof updatedAt !== 'string' ||
     !Number.isFinite(Date.parse(updatedAt)) || typeof nodeExecutionAvailable !== 'boolean' || !Array.isArray(nodeStates) ||
     !Array.isArray(rows) || rows.length === 0 || rows.length > 10000) throw new TypeError('Invalid canvas position data');
 const ids = new Set<string>();
 const positions = rows.map(row => {
  if (!Array.isArray(row) || row.length !== 3 || !isId(row[0]) || ids.has(row[0]) ||
      !isCoordinate(row[1]) || !isCoordinate(row[2])) throw new TypeError('Invalid canvas position');
  ids.add(row[0]);
  return {id:row[0],x:row[1],y:row[2]};
 });
 return {type:'event',event:'canvas.delta',id:cursor,data:{
  schemaVersion:'1',projectId,graphRevision,eventCursor:cursor,updatedAt,nodeStates,nodeExecutionAvailable,kind:'DELTA',fromRevision,
  delta:{positions,upsertNodes:[],removeNodeIds:[],upsertEdges:[],removeEdgeIds:[]},
 }};
}
