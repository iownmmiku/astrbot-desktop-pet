; Removes the login startup entry on uninstall, but only when it points at this
; installation (a portable copy may own it) and not during an upgrade, where the
; old version is uninstalled before the new one is installed.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AstrBotDesktopPet"
    StrCpy $1 "$\"$INSTDIR\"
    StrLen $2 $1
    StrCpy $3 $0 $2
    ${if} $3 == $1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AstrBotDesktopPet"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "AstrBotDesktopPet"
    ${endIf}
  ${endIf}
!macroend
