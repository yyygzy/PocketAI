; 墨匣安装器扩展：覆盖升级时保住 ≤1.2.8 留在安装目录里的用户数据。
;
; 背景：electron-builder 的 NSIS 在覆盖安装时会先跑旧卸载器（installSection.nsh 里
; uninstallOldVersion），旧卸载器把整个 $INSTDIR 改名搬到 $PLUGINSDIR\old-install 再删掉
; （uninstaller.nsh 的 ${isUpdated} 分支），装完才轮到新文件落地。于是旧版放在
; $INSTDIR\data 的用户数据会在 1.3.0 首次启动之前就消失——应用内那套首启迁移
; （src/main/portable.ts）根本没机会看到它。
;
; customInit 在 .onInit 里、installSection 之前执行（installer.nsi:79），此时 $INSTDIR
; 已被 initMultiUser 按上一次安装的 InstallLocation 还原。这里把旧数据搬到新落点
; $APPDATA\Moxia\data（与安装版一致），移动失败再用 xcopy 兜底；两边都失败时保持原样，
; 让首启迁移/用户手动处理，不吞错误。
;
; 只处理「安装目录里确实有 app.db」的旧安装；全新安装、已经迁过的新位置都不会命中。

!macro MoxiaMoveLegacyData
  ${If} ${FileExists} "$INSTDIR\data\app.db"
  ${AndIfNot} ${FileExists} "$APPDATA\Moxia\data\app.db"
    DetailPrint "Moxia: moving user data out of the install directory..."
    CreateDirectory "$APPDATA\Moxia"

    ClearErrors
    Rename "$INSTDIR\data" "$APPDATA\Moxia\data"
    ${If} ${Errors}
      ; 跨卷（安装目录在 D: 等）时 Rename 会失败，退回复制
      DetailPrint "Moxia: rename failed, copying instead"
      nsExec::ExecToLog 'xcopy /e /i /h /y "$INSTDIR\data" "$APPDATA\Moxia\data"'
      Pop $R9
      ${If} $R9 == "0"
        RMDir /r "$INSTDIR\data"
      ${Else}
        DetailPrint "Moxia: xcopy exited with $R9, keeping the old data in place"
      ${EndIf}
    ${EndIf}

    ; 迁移标记（应用只判断存在性，内容给人看）。写成正斜杠，免得 JSON 里出现裸反斜杠。
    ${If} ${FileExists} "$APPDATA\Moxia\data\app.db"
      FileOpen $R8 "$APPDATA\Moxia\data\migrated-from.json" w
      FileWrite $R8 '{"by":"nsis-updater","from":"install-dir/data","to":"appdata/Moxia/data"}'
      FileClose $R8
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  !insertmacro MoxiaMoveLegacyData
!macroend

; 卸载时只删程序文件，用户数据留在 $APPDATA\Moxia\data（重装直接沿用）。
; 这是产品决定：卸载界面上把数据位置写清楚，免得用户以为卸载=清空。
; 覆盖升级时旧卸载器会被连带调用，此时不能弹窗（会卡住更新），所以按 isUpdated 排除。
!macro customUnInstall
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    MessageBox MB_OK|MB_ICONINFORMATION "用户数据保存在：$\r$\n$APPDATA\Moxia\data$\r$\n$\r$\n本次卸载只会删除程序文件，不会删除该目录；重新安装后会自动沿用。$\r$\n如需彻底清除，请在卸载后手动删除该目录。"
  ${EndIf}
!macroend

