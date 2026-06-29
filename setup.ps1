# setup.ps1 — 새 환경 초기화 스크립트
# setup.bat 더블클릭 시 자동 실행됩니다

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host " =============================================" -ForegroundColor Cyan
Write-Host "   메일 스팸 정리기 -- 환경 설정" -ForegroundColor Cyan
Write-Host " =============================================" -ForegroundColor Cyan
Write-Host ""

# ── Node.js 확인 ──────────────────────────────────────────────────
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host " [오류] Node.js 가 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "        https://nodejs.org 에서 LTS 버전 설치 후 다시 실행하세요." -ForegroundColor Red
    exit 1
}
$nodeVer = & node -v
Write-Host " [OK] Node.js $nodeVer 확인됨" -ForegroundColor Green
Write-Host ""

# ── 루트 패키지 설치 ──────────────────────────────────────────────
$rootModules = Join-Path $ProjectDir "node_modules"
if (-not (Test-Path $rootModules)) {
    Write-Host " [1/4] 패키지 설치 중... (시간이 걸릴 수 있습니다)" -ForegroundColor Yellow
    Push-Location $ProjectDir
    & npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host " [오류] npm install 실패" -ForegroundColor Red
        exit 1
    }
    Write-Host " [OK] 루트 패키지 설치 완료" -ForegroundColor Green
} else {
    Write-Host " [OK] 루트 node_modules 이미 존재 -- 건너뜀" -ForegroundColor Green
}
Write-Host ""

# ── 클라이언트 패키지 설치 ────────────────────────────────────────
$clientModules = Join-Path $ProjectDir "client\node_modules"
if (-not (Test-Path $clientModules)) {
    Write-Host " [2/4] 클라이언트 패키지 설치 중..." -ForegroundColor Yellow
    Push-Location (Join-Path $ProjectDir "client")
    & npm install
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        Write-Host " [오류] client npm install 실패" -ForegroundColor Red
        exit 1
    }
    Write-Host " [OK] 클라이언트 패키지 설치 완료" -ForegroundColor Green
} else {
    Write-Host " [OK] client/node_modules 이미 존재 -- 건너뜀" -ForegroundColor Green
}
Write-Host ""

# ── React 클라이언트 빌드 ─────────────────────────────────────────
Write-Host " [3/4] 웹 UI 빌드 중..." -ForegroundColor Yellow
Push-Location (Join-Path $ProjectDir "client")
& npm run build
Pop-Location
if ($LASTEXITCODE -ne 0) {
    Write-Host " [오류] 클라이언트 빌드 실패" -ForegroundColor Red
    exit 1
}
Write-Host " [OK] 웹 UI 빌드 완료" -ForegroundColor Green
Write-Host ""

# ── 아이콘 + 바탕화면 바로가기 생성 ──────────────────────────────
Write-Host " [4/4] 바탕화면 아이콘 생성 중..." -ForegroundColor Yellow
& (Join-Path $ProjectDir "setup-shortcut.ps1")
if ($LASTEXITCODE -ne 0) {
    Write-Host " [오류] 바로가기 생성 실패" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host " =============================================" -ForegroundColor Cyan
Write-Host "   설정 완료!" -ForegroundColor Cyan
Write-Host " =============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "   바탕화면의 'Mail Spam Cleaner' 아이콘을 더블클릭하면 앱이 실행됩니다." -ForegroundColor White
Write-Host ""
Write-Host "   [Gmail 사용 시 추가 설정]" -ForegroundColor Yellow
Write-Host "     1. Google Cloud Console 에서 OAuth2 자격증명 발급" -ForegroundColor White
Write-Host "     2. credentials.json 파일을 프로젝트 루트에 배치" -ForegroundColor White
Write-Host "        (최초 실행 후 브라우저 인증 -> token.json 자동 생성)" -ForegroundColor White
Write-Host ""
