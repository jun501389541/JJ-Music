import {validateLyricOffsetKey} from './lyric-offset'
export interface ResumePoint {key:string;positionMs:number;durationMs:number;updatedAt:number}
export interface ResumePatch {key:string;point:ResumePoint|null}
export interface ResumeSnapshot {revision:number;records:Record<string,ResumePoint>}
export const RESUME_MAX_BYTES=8*1024*1024
export function resumeKey(raw:unknown):asserts raw is string {validateLyricOffsetKey(raw)}
export function resumeInteger(raw:unknown):asserts raw is number {if(!Number.isSafeInteger(raw)||(raw as number)<0)throw Error('续播记录数值无效')}
export function resumePoint(raw:ResumePoint):ResumePoint{
 resumeKey(raw?.key);for(const n of [raw.positionMs,raw.durationMs,raw.updatedAt])resumeInteger(n)
 if(raw.durationMs<=10000||raw.positionMs<5000||raw.positionMs>=raw.durationMs-5000)throw Error('续播位置不在有效范围')
 return{key:raw.key,positionMs:raw.positionMs,durationMs:raw.durationMs,updatedAt:raw.updatedAt}
}
export function resumeBatch(raw:unknown):ResumePatch[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>32)throw Error('续播批次无效')
 const keys=new Set<string>()
 return raw.map(p=>{resumeKey(p?.key);if(keys.has(p.key))throw Error('续播批次身份重复');keys.add(p.key);const point=p.point===null?null:resumePoint(p.point);if(point&&point.key!==p.key)throw Error('续播身份不一致');return{key:p.key,point}})
}
export function resumeCandidate(key:string,time:number,duration:number):ResumePoint|null|undefined{
 if(!Number.isFinite(time)||time<0||!Number.isFinite(duration)||duration<=0)return undefined
 const positionMs=Math.floor(time*1000),durationMs=Math.floor(duration*1000)
 if(!Number.isSafeInteger(positionMs)||!Number.isSafeInteger(durationMs))return undefined
 if(durationMs<=10000||positionMs<5000||positionMs>=durationMs-5000)return null
 return{key,positionMs,durationMs,updatedAt:Date.now()}
}
