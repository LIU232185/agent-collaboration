$ErrorActionPreference = 'Stop'
$researchRoot = $PSScriptRoot
$researchPython = Join-Path $researchRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $researchPython)) {
    throw '缺少项目虚拟环境，请按 research/README.md 安装依赖。'
}
Push-Location -LiteralPath $researchRoot
try {
    & $researchPython -m uvicorn research.api:app --host 127.0.0.1 --port 4320
} finally {
    Pop-Location
}
