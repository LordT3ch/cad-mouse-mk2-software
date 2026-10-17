# Builds app\tray\CadMouseTray.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
# Downloads the WebView2 SDK dlls from NuGet first if they are missing (pinned version + SHA256).
param(
  [string]$WebView2Version = '1.0.4258.31',
  [string]$WebView2Sha256 = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9'
)
$ErrorActionPreference = 'Stop'
$tray = (Resolve-Path (Join-Path $PSScriptRoot '..\app\tray')).Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$dlls = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'

if ($dlls | Where-Object { -not (Test-Path (Join-Path $tray $_)) }) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "webview2-$WebView2Version"
  $zip = "$tmp.zip"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$WebView2Version" -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
  if ($hash -ne $WebView2Sha256) { throw "WebView2 package hash mismatch: $hash" }
  Expand-Archive $zip $tmp -Force
  Copy-Item "$tmp\lib\net462\Microsoft.Web.WebView2.Core.dll", "$tmp\lib\net462\Microsoft.Web.WebView2.WinForms.dll", "$tmp\runtimes\win-x64\native\WebView2Loader.dll" $tray
  Copy-Item "$tmp\LICENSE.txt" (Join-Path $tray 'WebView2-LICENSE.txt')
}

Push-Location $tray
try {
  & $csc /nologo /target:winexe /optimize /codepage:65001 /r:System.Web.Extensions.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll /win32icon:cadmouse.ico /out:CadMouseTray.exe CadMouseTray.cs
  if ($LASTEXITCODE) { throw "csc failed ($LASTEXITCODE)" }
  "Built $tray\CadMouseTray.exe"
} finally {
  Pop-Location
}
