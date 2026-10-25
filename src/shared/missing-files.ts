import type {LocalMusicInfo,PlayableTrack} from './types'
export const MISSING_MAX_REFERENCES=50000
export const MISSING_MAX_ROWS=500
export interface LocalReferenceOrigin{id:string;name:string}
export interface LocalReferenceInput{track:PlayableTrack;origin:LocalReferenceOrigin}
export interface LocalReferenceSnapshot{references:LocalReferenceInput[];limited?:boolean}
export interface MissingFileRow{track:LocalMusicInfo;origins:LocalReferenceOrigin[];status:'missing'|'unavailable';message:string}
export interface MissingFilesResult{checkedAt:string;total:number;checked:number;present:number;missing:number;unavailable:number;rows:MissingFileRow[];limited:boolean;timedOut:boolean;warnings:string[]}
