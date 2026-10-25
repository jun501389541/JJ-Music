/** Owned generated music for repeatable offline tests. Never reads a personal library. */
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import NodeID3 from 'node-id3'
export function createTestMusicFixture(){
 const base=resolve(tmpdir()),dir=mkdtempSync(join(base,'jj-offline-music-'))
 const cleanup=()=>{if(dirname(resolve(dir))!==base||!dir.startsWith(join(base,'jj-offline-music-')))throw Error('unsafe fixture cleanup');rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50})}
 try{
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGN8AAAAASUVORK5CYII=','base64')
  for(let i=0;i<2;i++){
   const tags=NodeID3.create({title:'Generated track '+i,artist:'Generated artist',album:'Generated album',unsynchronisedLyrics:{language:'eng',text:'[00:00.100]Generated first line\n[00:00.500]Generated second line'},image:{mime:'image/png',type:{id:3,name:'front cover'},description:'Generated',imageBuffer:image}})
   if(!Buffer.isBuffer(tags))throw Error('could not create generated tags')
   const wav=Buffer.alloc(16044);wav.write('RIFF');wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40)
   const chunk=Buffer.alloc(8+tags.length+(tags.length%2));chunk.write('id3 ');chunk.writeUInt32LE(tags.length,4);tags.copy(chunk,8)
   const bytes=Buffer.concat([wav,chunk]);bytes.writeUInt32LE(bytes.length-8,4)
   const folder=i?join(dir,'nested'):dir;mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'generated-'+i+'.wav'),bytes)
  }
  return{dir,cleanup}
 }catch(error){cleanup();throw error}
}
