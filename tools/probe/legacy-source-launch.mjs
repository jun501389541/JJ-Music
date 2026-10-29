// Historical WL0 comparison fixture ONLY. Never imported by product code.
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function launchLegacy({nodeExec,hostPath,scriptPath,initPath,scratchDir,memoryLimitMb}) {
  const vbsFile=join(scratchDir,'launch.vbs'),cmdFile=join(scratchDir,'launch.cmd')
  const args=`--max-old-space-size=${memoryLimitMb} "${hostPath}" "${scriptPath}" "${initPath}" "${scratchDir}"`
  writeFileSync(vbsFile,['Set sh = CreateObject("WScript.Shell")','sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',`sh.Run """${nodeExec}"" ${args.replace(/"/g,'""')}", 0, False`].join('\r\n'))
  writeFileSync(cmdFile,`@echo off\r\ncscript //nologo "${vbsFile}"\r\n`)
  return {wrapper:spawn('runas',['/trustlevel:0x20000',`"${cmdFile}"`],{stdio:'ignore',windowsHide:true,windowsVerbatimArguments:true})}
}
export function killLegacyFixture(pid) {
  const tool=join(process.env.SystemRoot??'C:\\Windows','System32/taskkill.exe')
  return spawnSync(tool,['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).status===0
}
