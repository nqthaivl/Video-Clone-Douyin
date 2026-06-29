param(
  [string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) "..\videocolab"),
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Parent = Split-Path -Parent $Destination

if (-not (Test-Path -LiteralPath $Parent)) {
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
}

$Destination = [System.IO.Path]::GetFullPath($Destination)
Write-Host "Exporting Colab runtime to: $Destination"

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

if ($Clean) {
  foreach ($name in @("backend", "omnivoice")) {
    $path = Join-Path $Destination $name
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Recurse -Force
    }
  }
}

foreach ($dir in @("backend", "omnivoice")) {
  $source = Join-Path $Root $dir
  $dest = Join-Path $Destination $dir
  Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
}

foreach ($file in @("pyproject.toml", "alembic.ini", "LICENSE", "Video_Clone_Douyin_Colab.ipynb")) {
  Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $Destination $file) -Force
}

$readme = @'
# Video Clone Colab Runtime

Repo này chỉ chứa phần runtime cần thiết để chạy backend Video Clone trên Google Colab.

Không cần đưa toàn bộ code desktop, Electron, frontend, build assets hoặc keygen lên Colab.

## File cần có

- `backend/`
- `omnivoice/`
- `pyproject.toml`
- `alembic.ini`
- `Video_Clone_Douyin_Colab.ipynb`
- `LICENSE`

## Cách cập nhật từ repo desktop

Chạy trong repo `Video-Clone-Douyin-main`:

```powershell
.\scripts\export-colab-runtime.ps1 -Destination "C:\path\to\videocolab" -Clean
```

Sau đó commit/push thư mục `videocolab` lên:

```text
https://github.com/nqthaivl/videocolab.git
```
'@

Set-Content -LiteralPath (Join-Path $Destination "README.md") -Value $readme -Encoding UTF8

Write-Host "Done. Review, commit, and push the destination repo."
