; This macro runs in installSection after CHECK_APP_RUNNING has stopped the old
; app, and before uninstallOldVersion can remove $INSTDIR\data.
; Defining customCheckAppRunning suppresses the template's own process-info
; include, so restore it explicitly for _CHECK_APP_RUNNING below.
!include "getProcessInfo.nsh"
Var pid

; CHECK_APP_RUNNING is skipped in NSIS's elevated inner instance. A standard
; user can therefore elevate into an old per-machine install and reach the old
; uninstaller without our migration hook. Guard the registered machine-wide
; installation during .onInit, which runs in both the outer and inner process.
; This branch only rejects ambiguous shared data; it never copies live files.
!macro customInit
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $R5 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $R5 != ""
      Push "$R5"
      Call GetInQuotes
      Pop $R6
      ${If} $R6 == ""
        SetErrorLevel 41
        Abort
      ${EndIf}
      Push $R6
      Call GetFileParent
      Pop $R7
      InitPluginsDir
      File /oname=$PLUGINSDIR\u0-migrate-init.ps1 "${BUILD_RESOURCES_DIR}\u0-migrate.ps1"
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\u0-migrate-init.ps1" -InstallDir "$R7" -InstallMode "all" -AppDataRoot "$APPDATA"`
      Pop $R8
      Pop $R9
      FileOpen $R0 "$TEMP\jj-music-u0-init.log" w
      FileWrite $R0 "registered=$R7 mode=$installMode exit=$R8 output=$R9$\r$\n"
      FileClose $R0
      ${If} $R8 != 0
        MessageBox MB_OK|MB_ICONSTOP "全机旧版安装目录仍含资料，无法自动确定所属账户。已在旧卸载器运行前停止；请按发布说明备份并恢复。" /SD IDOK
        SetErrorLevel $R8
        Abort
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ; The stock uninstaller uses the registered old location, which can differ
    ; from the newly selected $INSTDIR. Refuse that case before it can erase
    ; data we have not inspected or stopped writing to.
    ReadRegStr $R2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${If} $R2 != ""
      !insertmacro GetInQuotes $R3 "$R2"
      ${If} $R3 == ""
        SetErrorLevel 41
        Abort
      ${EndIf}
      Push $R3
      Call GetFileParent
      Pop $R4
      ${If} $R4 != "$INSTDIR"
        MessageBox MB_OK|MB_ICONSTOP "旧版安装目录与新目录不同；请先保持原安装目录完成资料迁移。" /SD IDOK
        SetErrorLevel 41
        Abort
      ${EndIf}
    ${EndIf}
    ${If} $installMode == "all"
      ReadRegStr $R2 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $R2 != ""
        MessageBox MB_OK|MB_ICONSTOP "检测到当前用户的旧版安装；请先按用户模式完成资料迁移。" /SD IDOK
        SetErrorLevel 41
        Abort
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\Uninstall JJ Music.exe"
      InitPluginsDir
      File /oname=$PLUGINSDIR\u0-migrate.ps1 "${BUILD_RESOURCES_DIR}\u0-migrate.ps1"
      nsExec::ExecToStack `"$PowerShellPath" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\u0-migrate.ps1" -InstallDir "$INSTDIR" -InstallMode "$installMode" -AppDataRoot "$APPDATA"`
      Pop $0
      Pop $1
      FileOpen $2 "$TEMP\jj-music-u0-installer.log" w
      FileWrite $2 "mode=$installMode dir=$INSTDIR appdata=$APPDATA exit=$0 output=$1$\r$\n"
      FileClose $2
      ${If} $0 != 0
        DetailPrint "$1"
        ${If} $0 == 42
          MessageBox MB_OK|MB_ICONSTOP "全机安装目录含有旧版资料，无法自动判定所属账户。安装已在卸载旧版前停止，旧版与资料仍在。请先备份安装目录中的 data 和 data-location.json，并按各账户核对恢复；详情见发布说明。" /SD IDOK
        ${Else}
          MessageBox MB_OK|MB_ICONSTOP "旧版数据迁移未通过校验，安装已在卸载旧版前停止。请查看安装日志。" /SD IDOK
        ${EndIf}
        SetErrorLevel $0
        Abort
      ${EndIf}
    ${EndIf}
  !endif
!macroend

; Only the NSIS installer writes this file. The ZIP remains portable.
!macro customInstall
  SetOutPath "$INSTDIR\resources"
  File /oname=nsis-install.marker "${BUILD_RESOURCES_DIR}\nsis-install.marker"
!macroend
