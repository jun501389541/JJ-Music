import type {LocalMusicInfo} from './types'
export interface RelinkReference{id:string;path:string}
export interface RelinkChoice{id:string;fileId:string}
export interface BatchRelinkRow{old:RelinkReference&Partial<LocalMusicInfo>;candidates:Array<{id:string;path:string}>;message?:string}
export interface BatchRelinkScan{token:string;folder:string;rows:BatchRelinkRow[];limited:boolean;scanned:number}
