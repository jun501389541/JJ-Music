import { spawnSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
export function buildSourceLauncher() {
  if(process.platform!=='win32')return
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
  const result=spawnSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/build-source-launcher.ps1')],{cwd:root,stdio:'inherit',windowsHide:true})
  if(result.error||result.status!==0)throw new Error('Windows source launcher build failed; MSVC x64 and Windows SDK are required')
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))buildSourceLauncher()
