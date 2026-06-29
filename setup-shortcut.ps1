# setup-shortcut.ps1
# 바탕화면 바로가기 생성 스크립트
# PowerShell 직접 실행: powershell -ExecutionPolicy Bypass -File setup-shortcut.ps1
# (setup.bat -> setup.ps1 에서 자동 호출됨)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$IcoPath    = Join-Path $ProjectDir "electron\icon.ico"

# ── Node.js 확인 ────────────────────────────────────────────────────
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Host "  [오류] Node.js 를 찾을 수 없습니다. Node.js 설치 후 다시 실행하세요." -ForegroundColor Red
    exit 1
}

# ── 아이콘 파일 생성 ─────────────────────────────────────────────────
if (-not (Test-Path $IcoPath)) {
    Write-Host "  아이콘 파일 생성 중..." -ForegroundColor Yellow
    try {
        & node (Join-Path $ProjectDir "electron\generate-icon.js")
        Write-Host "  [OK] 아이콘 생성 완료" -ForegroundColor Green
    } catch {
        Write-Host "  [경고] 아이콘 생성 실패 -- 기본 아이콘으로 계속 진행합니다." -ForegroundColor Yellow
        $IcoPath = $null
    }
}

# ── run-app.vbs 생성 (콘솔 창 없이 앱 실행) ──────────────────────────
$VbsPath  = Join-Path $ProjectDir "run-app.vbs"
$LaunchJs = Join-Path $ProjectDir "electron\launch.js"
$vbsContent = 'Set WshShell = CreateObject("WScript.Shell")' + "`r`n" +
              "WshShell.CurrentDirectory = " + '"' + $ProjectDir + '"' + "`r`n" +
              'WshShell.Run "node " & Chr(34) & "' + $LaunchJs + '" & Chr(34), 0, False'
[System.IO.File]::WriteAllText($VbsPath, $vbsContent, [System.Text.Encoding]::ASCII)
Write-Host "  [OK] run-app.vbs 생성 완료" -ForegroundColor Green

# ── 바탕화면 바로가기 생성 ───────────────────────────────────────────
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$LnkPath     = [System.IO.Path]::Combine($DesktopPath, "Mail Spam Cleaner.lnk")

$Wsh      = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut($LnkPath)
$Shortcut.TargetPath       = "wscript.exe"
$Shortcut.Arguments        = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.Description      = "Mail Spam Cleaner"
if ($IcoPath -and (Test-Path $IcoPath)) {
    $Shortcut.IconLocation = "$IcoPath,0"
}
$Shortcut.Save()

Write-Host "  [OK] 바탕화면 바로가기 생성 완료 -> $LnkPath" -ForegroundColor Green
