$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Add local uv and Node.js installation paths to PATH if not already present
$LocalUvPath = Join-Path $env:USERPROFILE ".local\bin"
if (Test-Path $LocalUvPath) {
    $env:Path = "$LocalUvPath;$env:Path"
}
$NodePath = "C:\Program Files\nodejs"
if (Test-Path $NodePath) {
    $env:Path = "$NodePath;$env:Path"
}
$PythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($PythonCmd) {
    $PythonScripts = Join-Path (Split-Path $PythonCmd.Source -Parent) "Scripts"
    if (Test-Path $PythonScripts) {
        $env:Path = "$PythonScripts;$env:Path"
    }
}

Write-Host "Bat dau thiet lap moi truong build ung dung doc lap..."
Write-Host "Thu muc goc du an: $Root"

# 1. Kiem tra uv
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw "Can cai dat uv truoc khi chay. Huong dan: https://docs.astral.sh/uv/"
}

# 2. Kiem tra node/npm
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Can cai dat Node.js / npm truoc khi chay."
}

# Tao cac thu muc dich
$TempDir = Join-Path $Root "tmp_downloads"
$PythonDest = Join-Path $Root "backend\python311"
$BinDest = Join-Path $Root "backend\bin"

if (-not (Test-Path $TempDir)) { New-Item -ItemType Directory -Force -Path $TempDir | Out-Null }
if (-not (Test-Path $PythonDest)) { New-Item -ItemType Directory -Force -Path $PythonDest | Out-Null }
if (-not (Test-Path $BinDest)) { New-Item -ItemType Directory -Force -Path $BinDest | Out-Null }

# Neu con ban embed Python 3.13 cu (sai phien ban), xoa de tai lai 3.11.9
if ((Test-Path (Join-Path $PythonDest "python.exe")) -and (Test-Path (Join-Path $PythonDest "python313.dll"))) {
    Write-Host "Phat hien Python embed 3.13 - thay bang 3.11.9 de khop .venv..."
    Remove-Item -Recurse -Force $PythonDest
    New-Item -ItemType Directory -Force -Path $PythonDest | Out-Null
}

# Ham tai tep tu URL
function Download-File {
    param (
        [string]$Url,
        [string]$OutPath
    )
    if (Test-Path $OutPath) {
        Write-Host "Tep da ton tai, bo qua tai xuong: $OutPath"
        return
    }
    Write-Host "Dang tai $Url ve $OutPath..."
    $webClient = New-Object System.Net.WebClient
    $webClient.DownloadFile($Url, $OutPath)
}

# 3. Tai va thiet lap Portable Python 3.11 (embed, khop voi .venv ben duoi)
$PythonZip = Join-Path $TempDir "python-3.11.9-embed-amd64.zip"
$PythonUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip"

if (-not (Test-Path (Join-Path $PythonDest "python.exe"))) {
    Download-File -Url $PythonUrl -OutPath $PythonZip
    Write-Host "Dang giai nen Portable Python vao $PythonDest..."
    Expand-Archive -Path $PythonZip -DestinationPath $PythonDest -Force
} else {
    Write-Host "Portable Python da duoc giai nen san tai: $PythonDest"
}

# BUOC QUAN TRONG: python311._pth phai tro toi site-packages (embed bo qua PYTHONPATH)
$pthFile = Join-Path $PythonDest "python311._pth"
$pthContent = @"
python311.zip
.
..\.venv\Lib\site-packages
import site
"@
Set-Content -Path $pthFile -Value $pthContent -Encoding ascii
Write-Host "Da cau hinh $pthFile tro toi .venv\Lib\site-packages"

# 4. Tai va thiet lap FFmpeg and FFprobe
$FfmpegZip = Join-Path $TempDir "ffmpeg-essentials_build.zip"
$FfmpegUrls = @(
    "https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
)

if (-not (Test-Path (Join-Path $BinDest "ffmpeg.exe")) -or -not (Test-Path (Join-Path $BinDest "ffprobe.exe"))) {
    if (-not (Test-Path $FfmpegZip)) {
        $downloaded = $false
        foreach ($FfmpegUrl in $FfmpegUrls) {
            try {
                Write-Host "Dang thu tai FFmpeg tu $FfmpegUrl ..."
                $webClient = New-Object System.Net.WebClient
                $webClient.DownloadFile($FfmpegUrl, $FfmpegZip)
                $downloaded = $true
                break
            } catch {
                Write-Host "Khong tai duoc tu $FfmpegUrl : $($_.Exception.Message)"
                if (Test-Path $FfmpegZip) { Remove-Item -Force $FfmpegZip }
            }
        }
        if (-not $downloaded) {
            throw "Khong the tai FFmpeg tu bat ky mirror nao."
        }
    } else {
        Write-Host "Tep da ton tai, bo qua tai xuong: $FfmpegZip"
    }
    Write-Host "Dang giai nen FFmpeg..."
    $FfmpegExtract = Join-Path $TempDir "ffmpeg_extracted"
    if (Test-Path $FfmpegExtract) { Remove-Item -Recurse -Force $FfmpegExtract | Out-Null }
    Expand-Archive -Path $FfmpegZip -DestinationPath $FfmpegExtract -Force

    $FfmpegExe = Get-ChildItem -Path $FfmpegExtract -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    $FfprobeExe = Get-ChildItem -Path $FfmpegExtract -Filter "ffprobe.exe" -Recurse | Select-Object -First 1

    if ($FfmpegExe -and $FfprobeExe) {
        Copy-Item $FfmpegExe.FullName (Join-Path $BinDest "ffmpeg.exe") -Force
        Copy-Item $FfprobeExe.FullName (Join-Path $BinDest "ffprobe.exe") -Force
        Write-Host "Da cau hinh thanh cong FFmpeg va FFprobe tai $BinDest"
    } else {
        throw "Khong tim thay ffmpeg.exe hoac ffprobe.exe trong tep zip vua tai."
    }
} else {
    Write-Host "FFmpeg va FFprobe da san sang tai $BinDest"
}

# 5. Khoi tao moi truong ao Python bang uv
Write-Host "Dang tao moi truong ao (.venv) su dung Python 3.11..."
if (Test-Path "$Root\backend\.venv") {
    uv venv --python 3.11 --clear "$Root\backend\.venv"
} else {
    uv venv --python 3.11 "$Root\backend\.venv"
}

# 6. Cai dat cac dependencies cho backend
Write-Host "Dang cai dat cac thu vien Python (backend) qua uv..."
uv pip install --python "$Root\backend\.venv\Scripts\python.exe" -e $Root
Write-Host "Da cai transformers >=5.3 (HiggsAudio TTS)."

# 7. Cai dat cac thu vien frontend qua npm
Write-Host "Dang cai dat thu vien Node.js..."
npm install --prefix $Root

# 8. Tai llama-server (llama.cpp) - giai nen TOAN BO zip (can DLL kem theo)
$LlamaInstallDir = Join-Path $BinDest "llama-b9821-win-cuda-12.4-x64"
$LlamaServerExe = Join-Path $LlamaInstallDir "llama-server.exe"
if (-not (Test-Path (Join-Path $LlamaInstallDir "llama-server-impl.dll"))) {
    Write-Host "Dang tai llama-server (llama.cpp)..."
    $LlamaZip = Join-Path $TempDir "llama-server.zip"
    $LlamaUrl = "https://github.com/ggml-org/llama.cpp/releases/download/b9821/llama-b9821-bin-win-cuda-12.4-x64.zip"
    try {
        Download-File -Url $LlamaUrl -OutPath $LlamaZip
        if (Test-Path $LlamaInstallDir) { Remove-Item -Recurse -Force $LlamaInstallDir | Out-Null }
        New-Item -ItemType Directory -Force -Path $LlamaInstallDir | Out-Null
        Expand-Archive -Path $LlamaZip -DestinationPath $LlamaInstallDir -Force
        if (Test-Path $LlamaServerExe) {
            Write-Host "Da cai llama-server tai $LlamaInstallDir"
        } else {
            Write-Host "Canh bao: khong tim thay llama-server.exe sau giai nen - se tai khi dung lan dau."
        }
    } catch {
        Write-Host "Canh bao: khong the tai llama-server ($($_.Exception.Message)). Ung dung se thu tai khi dich lan dau."
    }
} else {
    Write-Host "llama-server da san sang tai $LlamaInstallDir"
}

# Xoa ban cai sai (chi co exe 9KB, thieu DLL)
$LegacyLlama = Join-Path $BinDest "llama-server.exe"
if (Test-Path $LegacyLlama) {
    Remove-Item -Force $LegacyLlama -ErrorAction SilentlyContinue
}

# 9. Don dep tep tam
if (Test-Path $TempDir) {
    Write-Host "Dang don dep cac tep tam..."
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue | Out-Null
}

Write-Host "======================================================="
Write-Host "THIET LAP HOAN TAT THANH CONG!"
Write-Host "Moi truong da san sang de dong goi ban chay doc lap."
Write-Host "Cach chay thu che do dev: npm run dev"
Write-Host "Cach dong goi portable (ZIP mang di may khac): .\window-package.ps1"
Write-Host "Cach build file cai dat/installer: npm run package"
Write-Host "======================================================="
