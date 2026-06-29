# Cai dat Video Clone tu thu muc win-unpacked hoac file ZIP portable.
param(
    [string]$SourceDir = "",
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Video Clone"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not $SourceDir) {
    $SourceDir = Join-Path $Root "release\win-unpacked"
}

if (-not (Test-Path (Join-Path $SourceDir "Video Clone.exe"))) {
    throw "Khong tim thay Video Clone.exe trong: $SourceDir"
}

Write-Host "Dang cai dat Video Clone vao: $InstallDir"
if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir "*") -Destination $InstallDir -Recurse -Force

$ExePath = Join-Path $InstallDir "Video Clone.exe"
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "Video Clone.lnk"
$Wsh = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $ExePath
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Save()

Write-Host "Da cai dat xong!"
Write-Host "  Thu muc: $InstallDir"
Write-Host "  Shortcut: $ShortcutPath"
