export interface LoopEditContext {key:string;generation:number;name:string;duration:number;a:number;b:number}
/** Strict user input; no Date coercion, exponent syntax or silently normalized clock segments. */
export function parseLoopTime(input:string):number{
 const parts=input.trim().split(':')
 if(input.length>40||!parts.length||parts.length>3||parts.some((part,i)=>!(i===parts.length-1?/^\d+(?:\.\d{1,3})?$/:/^\d+$/).test(part)))throw Error('请输入秒数、分:秒或时:分:秒，小数最多3位')
 const values=parts.map(Number)
 if(parts.length>1&&values.at(-1)!>=60||parts.length===3&&values[1]>=60)throw Error('秒数和小时格式中的分钟须小于60')
 const seconds=values.reduce((total,value)=>total*60+value,0)
 if(!Number.isFinite(seconds)||!Number.isSafeInteger(Math.round(seconds*1000)))throw Error('时间超出有效范围')
 return seconds
}
/** Floor rather than round: an editable default B must remain inside the actual media duration. */
export function formatLoopTime(seconds:number):string{
 const millis=Math.floor(seconds*1000),whole=Math.floor(millis/1000),fraction=millis%1000
 if(!Number.isSafeInteger(millis)||millis<0)throw Error('时间无效')
 const hours=Math.floor(whole/3600),minutes=Math.floor(whole/60)%60,tail=String(whole%60).padStart(2,'0')
 return (hours?`${hours}:${String(minutes).padStart(2,'0')}`:String(Math.floor(whole/60)))+':'+tail+(fraction?'.'+String(fraction).padStart(3,'0').replace(/0+$/,''):'')
}
