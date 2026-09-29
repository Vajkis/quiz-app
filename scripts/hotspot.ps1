# Turns the Windows Mobile Hotspot on/off without an internet connection, so
# players' phones can join the laptop directly and open the quiz.
#
# Windows only enables the hotspot when it has a connection to "share", so this
# shares the Microsoft KM-TEST Loopback Adapter (install once via `hdwwiz` ->
# Network adapters -> Microsoft -> Microsoft KM-TEST Loopback Adapter). If the
# loopback adapter isn't there, it falls back to the current internet connection.
#
# Must run under Windows PowerShell 5.1 (powershell.exe) - PowerShell 7 can't
# load the WinRT types used here.
#
# The hotspot is pinned to 2.4 GHz by default: older phones can't see 5 GHz
# networks, and 2.4 GHz reaches further across a room. Use -Band 5 or -Band auto
# to change that.
#
#   powershell -ExecutionPolicy Bypass -File scripts\hotspot.ps1 [toggle|start|stop|status] [-Band 2.4|5|auto]
param(
  [ValidateSet('toggle', 'start', 'stop', 'status')]
  [string]$Action = 'toggle',
  [ValidateSet('2.4', '5', 'auto')]
  [string]$Band = '2.4',
  [switch]$Pause
)

$ErrorActionPreference = 'Stop'

function Finish($code) {
  if ($Pause) { Write-Host ''; Read-Host 'Press Enter to close' | Out-Null }
  exit $code
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
    })[0]
  function AwaitAction($op) { $asTaskAction.Invoke($null, @($op)).Wait(-1) | Out-Null }

  $netInfo = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
  $tetherType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
  $resultType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]

  $connProfile = $null
  $loopback = Get-NetAdapter | Where-Object InterfaceDescription -like '*KM-TEST Loopback*' | Select-Object -First 1
  if ($loopback) {
    if ($loopback.Status -eq 'Disabled') { Enable-NetAdapter -Name $loopback.Name -Confirm:$false; Start-Sleep -Seconds 3 }
    $connProfile = $netInfo::GetConnectionProfiles() |
      Where-Object { "{$($_.NetworkAdapter.NetworkAdapterId)}" -eq $loopback.InterfaceGuid } |
      Select-Object -First 1
  }
  if (-not $connProfile) { $connProfile = $netInfo::GetInternetConnectionProfile() }
  if (-not $connProfile) {
    # Any connected network will do (e.g. Wi-Fi with no internet), not just one with internet.
    $connProfile = $netInfo::GetConnectionProfiles() |
      Where-Object { $_.GetNetworkConnectivityLevel() -ne 'None' } |
      Select-Object -First 1
  }
  if (-not $connProfile) {
    if ($loopback) {
      Write-Host "Loopback adapter '$($loopback.Name)' found (status: $($loopback.Status)), but Windows has no network profile for it yet. Wait ~30 s and try again, or disable/enable it in ncpa.cpl." -ForegroundColor Red
    } else {
      Write-Host 'No connection to share, and the Microsoft KM-TEST Loopback Adapter is not installed.' -ForegroundColor Red
      Write-Host 'Install it once: Win+R -> hdwwiz -> Advanced -> Network adapters -> Microsoft -> Microsoft KM-TEST Loopback Adapter.'
    }
    Finish 1
  }

  $mgr = $tetherType::CreateFromConnectionProfile($connProfile)
  $isOn = $mgr.TetheringOperationalState -eq 'On'

  if ($Action -eq 'toggle') { $Action = if ($isOn) { 'stop' } else { 'start' } }

  if ($Action -eq 'start' -and -not $isOn) {
    $wantBand = @{ '2.4' = 'TwoPointFourGigahertz'; '5' = 'FiveGigahertz'; 'auto' = 'Auto' }[$Band]
    $cfg = $mgr.GetCurrentAccessPointConfiguration()
    if ("$($cfg.Band)" -ne $wantBand) {
      if ($wantBand -ne 'Auto' -and -not $cfg.IsBandSupported($wantBand)) { throw "This Wi-Fi adapter can't host a hotspot on $Band GHz." }
      $cfg.Band = $wantBand
      AwaitAction ($mgr.ConfigureAccessPointAsync($cfg))
    }
    $result = Await ($mgr.StartTetheringAsync()) $resultType
    if ($result.Status -ne 'Success') { throw "Start failed: $($result.Status) $($result.AdditionalErrorMessage)" }
  } elseif ($Action -eq 'stop' -and $isOn) {
    $result = Await ($mgr.StopTetheringAsync()) $resultType
    if ($result.Status -ne 'Success') { throw "Stop failed: $($result.Status) $($result.AdditionalErrorMessage)" }
  }

  $state = $mgr.TetheringOperationalState
  $cfg = $mgr.GetCurrentAccessPointConfiguration()
  Write-Host "Hotspot: $state" -ForegroundColor $(if ($state -eq 'On') { 'Green' } else { 'Yellow' })
  if ($state -eq 'On') {
    Write-Host "Wi-Fi:    $($cfg.Ssid)"
    Write-Host "Password: $($cfg.Passphrase)"
    $bandLabel = @{ 'TwoPointFourGigahertz' = '2.4 GHz'; 'FiveGigahertz' = '5 GHz'; 'Auto' = 'auto' }["$($cfg.Band)"]
    Write-Host "Band:     $bandLabel"
    Write-Host "Clients:  $($mgr.ClientCount) / $($mgr.MaxClientCount)"
  }
  Finish 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  Finish 1
}
