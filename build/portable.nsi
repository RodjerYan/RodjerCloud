Unicode True
RequestExecutionLevel admin
!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "RodjerCloud"
OutFile "dist\RodjerCloudPortable.exe"
Caption "RodjerCloud Portable"
DirText "" "" "" "Выберите папку для извлечения"

Function .onInit
  StrCpy $INSTDIR "$LOCALAPPDATA\RodjerCloud"
  SetShellVarContext all
FunctionEnd

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath $INSTDIR
  File /r "dist\win-unpacked\*.*"

  CreateShortCut "$INSTDIR\RodjerCloud.lnk" "$INSTDIR\RodjerCloud.exe"

  DetailPrint "Запуск RodjerCloud..."
  ExecWait '"$INSTDIR\RodjerCloud.exe"'
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
SectionEnd
