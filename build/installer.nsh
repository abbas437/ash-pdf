; ASH PDF Studio — custom NSIS hooks (included by electron-builder via nsis.include).
;
; Registers the app as an *available* handler for .pdf ("Open with" list and
; Settings > Default apps) WITHOUT changing the default value of Software\Classes\.pdf.
; electron-builder's built-in `fileAssociations` (APP_ASSOCIATE) writes that default
; value, which can make this app the .pdf handler without asking — so it is not used.
; The user picks the default themselves in Windows Settings.
;
; SHELL_CONTEXT is HKCU for per-user installs (perMachine: false), HKLM otherwise.

!define ASH_PROGID "ASHPMCS.PDFStudio.Document"
!define ASH_CAPS "Software\ASH PMCS\ASH PDF Studio\Capabilities"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${ASH_PROGID}" "" "PDF document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${ASH_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${ASH_PROGID}\shell\open" "" "Open with ASH PDF Studio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${ASH_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${ASH_PROGID}"

  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "ASH PDF Studio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'

  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}" "ApplicationName" "ASH PDF Studio"
  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}" "ApplicationDescription" "Free PDF viewer and editor"
  WriteRegStr SHELL_CONTEXT "${ASH_CAPS}\FileAssociations" ".pdf" "${ASH_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "ASH PDF Studio" "${ASH_CAPS}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${ASH_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${ASH_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "ASH PDF Studio"
  DeleteRegKey SHELL_CONTEXT "Software\ASH PMCS\ASH PDF Studio"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\ASH PMCS"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
