# Builds the firmware and flashes it to the mouse (1200-baud reset into the bootloader + UF2 copy to RPI-RP2).
# Closes CadMouseTray first so it releases the COM port.
# Usage: .\tools\flash-firmware.ps1            (3Dconnexion VID, default)
#        .\tools\flash-firmware.ps1 generic_vid (own VID, see README)
param([string]$Env = 'seeed_xiao_rp2040')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pio = Join-Path $env:USERPROFILE '.platformio\penv\Scripts\pio.exe'
if (-not (Test-Path $pio)) { $pio = 'pio' }  # PlatformIO on PATH

Get-Process CadMouseTray -ErrorAction SilentlyContinue | Stop-Process -Force

Push-Location $repo
try {
  & $pio run -e $Env
  if ($LASTEXITCODE) { throw 'Build failed' }

  $port = Get-CimInstance Win32_PnPEntity |
    Where-Object { $_.DeviceID -match 'VID_256F&PID_C631|VID_2E8A&PID_0CAD|VID_2E8A&PID_0CAE' -and $_.Name -match '\((COM\d+)\)' } |
    ForEach-Object { $Matches[1] } | Select-Object -First 1
  if ($port) {
    # 1200-baud touch puts the RP2040 into the bootloader (picotool then fails, that is fine)
    $ErrorActionPreference = 'Continue'
    & $pio run -e $Env -t upload --upload-port $port 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
  }

  $v = $null
  for ($i = 0; $i -lt 30 -and -not $v; $i++) {
    Start-Sleep -Milliseconds 500
    $v = Get-Volume | Where-Object FileSystemLabel -eq 'RPI-RP2'
  }
  if (-not $v) { throw 'RPI-RP2 drive did not appear - hold BOOT on the XIAO while plugging in USB' }
  Copy-Item ".pio\build\$Env\firmware.uf2" "$($v.DriveLetter):\"
  "Flashed (port $port, drive $($v.DriveLetter):)"
} finally {
  Pop-Location
}
