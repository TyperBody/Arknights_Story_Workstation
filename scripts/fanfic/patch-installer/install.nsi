; Arkstage 素材补丁安装器（Windows，NSIS）。
; 由 `scripts/fanfic/build-patch-installer.mjs --win` 生成：占位符替换后调用 makensis。
;
; 用户口径：补丁是**安装包形式**，装到 Arkstage 的目录里；**没有本体则提示没有本体**。
; 查找顺序（与 `install.sh` 一致）：
;   1. 注册表 `HKCU\Software\Arkstage` 的 `InstallDir`（安装器写入）；
;   2. `%LOCALAPPDATA%\cn.aunly.arkstage`（数据根默认位）；
;   3. `%PROGRAMFILES%\Arkstage`；
;   4. 当前目录（便携版：`Arkstage.exe` 旁边）。
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APP_NAME "Arkstage"
!define PATCH_KIND "__KIND__"
!define PATCH_VERSION "__VERSION__"
!define PAYLOAD "__PAYLOAD__"
!define OUT_FILE "__OUT__"

Name "${APP_NAME} ${PATCH_KIND} ${PATCH_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\cn.aunly.arkstage"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  ; 1) 注册表
  ReadRegStr $0 HKCU "Software\${APP_NAME}" "InstallDir"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\*.*"
    StrCpy $INSTDIR $0
    Return
  ${EndIf}
  ; 2) LOCALAPPDATA 默认数据根
  ${If} ${FileExists} "$LOCALAPPDATA\cn.aunly.arkstage\*.*"
    StrCpy $INSTDIR "$LOCALAPPDATA\cn.aunly.arkstage"
    Return
  ${EndIf}
  ; 3) Program Files
  ${If} ${FileExists} "$PROGRAMFILES64\${APP_NAME}\Arkstage.exe"
    StrCpy $INSTDIR "$PROGRAMFILES64\${APP_NAME}"
    Return
  ${EndIf}
  ; 4) 便携版：安装器旁边有 Arkstage.exe
  ${If} ${FileExists} "$EXEDIR\Arkstage.exe"
    StrCpy $INSTDIR "$EXEDIR"
    Return
  ${EndIf}
  ; 都没有 → 提示"没有本体"，退出（不写任何文件）
  MessageBox MB_ICONSTOP|MB_OK "没有找到 Arkstage 本体。$\r$\n请先安装 / 解压 Arkstage，再把本补丁安装到它的资源目录。$\r$\n$\r$\n（本补丁只补素材：${PATCH_KIND} ${PATCH_VERSION}）"
  Abort
FunctionEnd

Section "素材补丁" SecPatch
  SetOutPath "$INSTDIR\assets\starter"
  DetailPrint "Arkstage 本体：$INSTDIR"
  DetailPrint "解压 ${PATCH_KIND} 补丁 → $INSTDIR\assets\starter（只补缺失，不覆盖已有）"
  ; `SetOverwrite off` = **不覆盖**用户已有文件（与 install.sh 的"只补缺失"一致）。
  SetOverwrite off
  File /r "${PAYLOAD}\*.*"
  SetOverwrite on
  DetailPrint "完成。"
SectionEnd

Section -Post
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
SectionEnd
