$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "Cần cài uv trước: https://docs.astral.sh/uv/"
}

uv venv --python 3.11 "$Root\backend\.venv"
uv pip install --python "$Root\backend\.venv\Scripts\python.exe" -e $Root
npm install --prefix $Root

# Cấu hình tự động sao chép ffmpeg/ffprobe vào dự án
$BinDir = "$Root\backend\bin"
if (-not (Test-Path $BinDir)) {
  New-Item -ItemType Directory -Force -Path $BinDir
}
$WingetPath = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
$GyanFFmpeg = Get-ChildItem -Path $WingetPath -Filter "*Gyan.FFmpeg*" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($GyanFFmpeg) {
  $FfmpegExe = Get-ChildItem -Path (Join-Path $GyanFFmpeg.FullName "ffmpeg-*-full_build\bin\ffmpeg.exe") -ErrorAction SilentlyContinue
  $FfprobeExe = Get-ChildItem -Path (Join-Path $GyanFFmpeg.FullName "ffmpeg-*-full_build\bin\ffprobe.exe") -ErrorAction SilentlyContinue
  if ($FfmpegExe -and $FfprobeExe) {
    Copy-Item $FfmpegExe.FullName "$BinDir\ffmpeg.exe" -Force
    Copy-Item $FfprobeExe.FullName "$BinDir\ffprobe.exe" -Force
    Write-Host "Đã sao chép ffmpeg và ffprobe từ Winget vào thư mục dự án."
  }
}

Write-Host "Hoàn tất. Chạy: cd `"$Root`"; npm run dev"
