# Takes this PC off the page and removes the agent. In an admin PowerShell:
#   irm '<dashboard>/install/windows/uninstall' | iex
& {
  $Dir = Join-Path $env:LOCALAPPDATA 'FleetAgent'
  if ($env:FLEET_INSTALL_NO_LOAD -ne '1') {
    Unregister-ScheduledTask -TaskName 'Fleet Updates agent' -Confirm:$false -ErrorAction SilentlyContinue
  }
  $Exe = Join-Path $Dir 'fleet-agent.exe'
  if (Test-Path $Exe) { & $Exe uninstall }
  Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
  Write-Output 'Fleet agent removed.'
}
