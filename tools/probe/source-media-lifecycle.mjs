/** Offline native Electron cancellation acceptance, with a disposable profile. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withDisposableProfile } from './isolated-profile.mjs'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const output=join(root,'.cache/online-reliability-streams')
await mkdir(output,{recursive:true})
function run(command,args,options={}) {
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:'inherit',...options})
    let timedOut=false
    const timer=setTimeout(()=>{timedOut=true;child.kill()},45000)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('close',(code,signal)=>{
      clearTimeout(timer)
      if(timedOut)reject(new Error('Native lifecycle probe exceeded 45 seconds'))
      else code===0?resolveRun():reject(new Error(`Probe exited ${code??signal}`))
    })
  })
}
const reportPath=join(output,'native-acceptance.json'),runId=`${Date.now()}-${process.pid}`
await writeFile(reportPath,JSON.stringify({runId,status:'starting',startedAt:new Date().toISOString()},null,2)+'\n')
try{
  // Build shipping modules on every run; do not accept a stale test bundle.
  await run(process.execPath,[join(root,'tools/build-test.mjs')])
  await withDisposableProfile(output, profile => run(
    join(root,'node_modules/electron/dist/electron.exe'),
    [join(root,'tools/probe/source-media-lifecycle-main.cjs')],
    {env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,NODE_OPTIONS:undefined,JJ_NATIVE_PROFILE:profile,JJ_NATIVE_OUTPUT:reportPath,JJ_NATIVE_RUN_ID:runId}}
  ))
}catch(error){
  let evidence={}
  try{const current=JSON.parse(await readFile(reportPath,'utf8'));if(current.runId===runId)evidence=current}catch{}
  await writeFile(reportPath,JSON.stringify({...evidence,runId,status:'failed',launcherError:error.message},null,2)+'\n')
  throw error
}
