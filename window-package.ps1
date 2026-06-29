# Dong goi Video Clone Windows portable - chay duoc tren may khac khong can cai Python/FFmpeg.
# Quy trinh: setup-portable.ps1 -> electron-builder (win-unpacked) -> bo sung site-packages -> ZIP
#
# Cach dung:
#   .\window-package.ps1
#   npm run package:windows
#
# Ket qua:
#   release\win-unpacked\          - thu muc chay truc tiep (Video Clone.exe)
#   release\Video-Clone-<ver>-win-x64-portable.zip

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

foreach ($p in @(
    (Join-Path $env:USERPROFILE ".local\bin"),
    "C:\Program Files\nodejs"
)) {
    if (Test-Path $p) { $env:Path = "$p;$env:Path" }
}
$PythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($PythonCmd) {
    $PythonScripts = Join-Path (Split-Path $PythonCmd.Source -Parent) "Scripts"
    if (Test-Path $PythonScripts) {
        $env:Path = "$PythonScripts;$env:Path"
    }
}

function Require-Path {
    param([string]$Path, [string]$Label)
    if (-not (Test-Path $Path)) {
        throw "Thieu $Label`: $Path"
    }
}

function New-ReleaseZip {
    param(
        [string]$SourceDir,
        [string]$ZipPath
    )
    if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
    Push-Location $SourceDir
    try {
        # Compress-Archive gioi han ~2GB; tar ho tro goi lon hon (Windows 10+)
        & tar -a -c -f $ZipPath *
        if ($LASTEXITCODE -ne 0) {
            throw "tar that bai khi nen ZIP (exit $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
}

function Sync-Tree {
    param(
        [string]$Src,
        [string]$Dest,
        [string[]]$ExcludeDir = @("__pycache__", ".git")
    )
    if (-not (Test-Path $Src)) {
        throw "Khong tim thay nguon: $Src"
    }
    $parent = Split-Path $Dest -Parent
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (Test-Path $Dest) {
        Remove-Item -Recurse -Force $Dest
    }
    $xd = @()
    foreach ($d in $ExcludeDir) { $xd += "/XD"; $xd += $d }
    & robocopy $Src $Dest /E /NFL /NDL /NJH /NJS /nc /ns /np @xd | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy that bai ($Src -> $Dest), exit $LASTEXITCODE"
    }
}

$SetupScript = Join-Path $Root "setup-portable.ps1"
Require-Path $SetupScript "setup-portable.ps1"

$pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$productName = if ($pkg.build.productName) { $pkg.build.productName } else { "Video-Clone" }
$safeName = ($productName -replace '[^\w\-]+', '-').Trim('-')

Write-Host "========================================"
Write-Host " Dong goi Windows portable: $productName v$version"
Write-Host "========================================"

# 1. Thiet lap moi truong portable (Python embed, FFmpeg, .venv site-packages)
Write-Host "`n[1/4] Thiet lap moi truong portable (setup-portable.ps1)..."
& $SetupScript
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "setup-portable.ps1 that bai (exit $LASTEXITCODE)."
}

$PythonExe = Join-Path $Root "backend\python311\python.exe"
$FfmpegExe = Join-Path $Root "backend\bin\ffmpeg.exe"
$FfprobeExe = Join-Path $Root "backend\bin\ffprobe.exe"
$SitePkgs = Join-Path $Root "backend\.venv\Lib\site-packages"

Require-Path $PythonExe "Portable Python (embed 3.11)"
Require-Path $FfmpegExe "FFmpeg"
Require-Path $FfprobeExe "FFprobe"
Require-Path $SitePkgs "Python site-packages (.venv)"

# 2. Build Electron (win-unpacked)
Write-Host "`n[2/4] Build ung dung Electron (npm run package:dir)..."
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Can cai Node.js / npm truoc khi dong goi."
}
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
npm run package:dir
if ($LASTEXITCODE -ne 0) {
    throw "Build that bai (exit code $LASTEXITCODE)."
}

$releaseDir = Join-Path $Root "release"
$unpackedDir = Join-Path $releaseDir "win-unpacked"
$packBackend = Join-Path $unpackedDir "resources\backend"
$appExe = Join-Path $unpackedDir "Video Clone.exe"

Require-Path $unpackedDir "thu muc build win-unpacked"
Require-Path $appExe "Video Clone.exe"

# 3. Bo sung runtime portable (electron-builder loai tru .venv)
Write-Host "`n[3/4] Bo sung Python portable + FFmpeg + thu vien Python vao goi..."
Require-Path $packBackend "resources\backend trong goi build"

Sync-Tree (Join-Path $Root "backend\python311") (Join-Path $packBackend "python311")
Sync-Tree (Join-Path $Root "backend\bin") (Join-Path $packBackend "bin")
Sync-Tree $SitePkgs (Join-Path $packBackend ".venv\Lib\site-packages")

# 4. Nen ZIP (noi dung win-unpacked, khong them lop thu muc win-unpacked)
$zipName = "$safeName-$version-win-x64-portable.zip"
$zipPath = Join-Path $releaseDir $zipName
$stagingZip = Join-Path $releaseDir "_packaging.zip"

Write-Host "`n[4/4] Nen thanh ZIP: $zipName ..."
if (Test-Path $stagingZip) { Remove-Item -Force $stagingZip }
New-ReleaseZip -SourceDir $unpackedDir -ZipPath $zipPath

$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

Write-Host ""
Write-Host "========================================"
Write-Host " HOAN TAT"
Write-Host "  Thu muc chay:  $unpackedDir"
Write-Host "  File ZIP:      $zipPath"
Write-Host "  Dung luong:    $sizeMb MB"
Write-Host ""
Write-Host "  Giai nen ZIP -> chay Video Clone.exe"
Write-Host "  Khong can cai Python, FFmpeg hay Node tren may dich."
Write-Host "  Model AI tai lan dau chay (luu trong %APPDATA%\VideoCloneDouyin\models)."
Write-Host "========================================"
