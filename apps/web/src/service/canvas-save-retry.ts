import {ApiError} from '../api/client';

/** Unknown transport outcomes keep the original immutable operation batch.
 * Authorization, invalid input and unsupported endpoints need another action. */
export function transientCanvasSaveFailure(error:unknown){
 return error instanceof TypeError||error instanceof ApiError&&(error.code==='INVALID_RESPONSE'||[408,429,500,502,503,504].includes(error.status));
}

export function canvasSaveRetryDelay(attempt:number){return [1000,2000,5000,10000,15000][Math.min(attempt,4)];}
