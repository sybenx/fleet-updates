# Installs the Fleet Updates agent as a Scheduled Task (every 10 minutes and at startup, Below
# Normal priority, runs whether or not the user is logged on). From the page, in an admin PowerShell:
#   $env:FLEET_APPROVER='<key>'; irm '<dashboard>/install/windows?t=<join token>' | iex
# The dashboard puts $FleetUrl and $FleetJoin at the top. This script only downloads the agent,
# checks its sha256, has it join, and sets up the task. $env:FLEET_INSTALL_NO_LOAD=1: no task (tests).
& {
  $ErrorActionPreference = 'Stop'
  $Server = if ($FleetUrl) { $FleetUrl } else { $env:FLEET_URL }
  if (-not $Server) { Write-Error 'No dashboard address.'; return }
  $Server = $Server.TrimEnd('/')
  $NoLoad = $env:FLEET_INSTALL_NO_LOAD -eq '1'
  if (-not $NoLoad) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Write-Error 'Run this in an admin PowerShell (right-click, Run as administrator).'; return }
  }
  $Dir = Join-Path $env:LOCALAPPDATA 'FleetAgent'
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $Exe = Join-Path $Dir 'fleet-agent.exe'
  $New = "$Exe.new"
  $Bin = 'fleet-agent-windows-amd64.exe'
  Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/agent/bin/$Bin" -OutFile $New
  $want = ((Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/agent/bin/$Bin.sha256").Content -split '\s+')[0]
  $have = (Get-FileHash -Algorithm SHA256 $New).Hash.ToLower()
  if (-not $want -or $want -ne $have) { Remove-Item $New; Write-Error 'The download does not match its sha256. Nothing installed.'; return }
  Move-Item -Force $New $Exe

  if ($FleetJoin) {
    & $Exe join --os windows --url $Server --approver "$env:FLEET_APPROVER" $FleetJoin
    if ($LASTEXITCODE -ne 0) { Write-Error 'Could not join.'; return }
  }

  $games = Join-Path $Dir 'games.txt'
  if (-not (Test-Path $games)) {
    "# One process name per line (no .exe). While one runs, nothing installs.`n# Minecraft clients and anything under steamapps\common count already." | Set-Content $games
  }
  if ($NoLoad) { Write-Output "installed $Exe (task not registered)"; return }

  $action = New-ScheduledTaskAction -Execute $Exe -Argument 'run' -WorkingDirectory $Dir
  $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
  $boot = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -Priority 7
  # S4U: runs whether or not the user is logged on, with no stored password.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
  Register-ScheduledTask -TaskName 'Fleet Updates agent' -Action $action -Trigger @($every, $boot) -Settings $settings -Principal $principal -Force | Out-Null
  Write-Output 'Fleet agent installed.'
}
