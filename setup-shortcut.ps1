# setup-shortcut.ps1
# Run: powershell -ExecutionPolicy Bypass -File setup-shortcut.ps1

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$IcoPath    = Join-Path $ProjectDir "electron\icon.ico"

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Write-Host "ERROR: Node.js not found. Please install Node.js first." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $IcoPath)) {
  Write-Host "Generating icon files..." -ForegroundColor Yellow
  & node (Join-Path $ProjectDir "electron\generate-icon.js")
}

# VBS wrapper (hides console window)
$VbsPath  = Join-Path $ProjectDir "run-app.vbs"
$LaunchJs = Join-Path $ProjectDir "electron\launch.js"
$vbsContent = 'Set WshShell = CreateObject("WScript.Shell")' + "`r`n" +
              "WshShell.CurrentDirectory = " + '"' + $ProjectDir + '"' + "`r`n" +
              'WshShell.Run "node """ & "' + $LaunchJs + '" & """, 0, False'
[System.IO.File]::WriteAllText($VbsPath, $vbsContent, [System.Text.Encoding]::ASCII)
Write-Host "OK: run-app.vbs created" -ForegroundColor Green

# Desktop shortcut (English name to avoid encoding issues)
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$LnkPath     = [System.IO.Path]::Combine($DesktopPath, "Mail Spam Cleaner.lnk")

$Wsh      = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut($LnkPath)
$Shortcut.TargetPath       = "wscript.exe"
$Shortcut.Arguments        = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.IconLocation     = $IcoPath + ",0"
$Shortcut.Description      = "Mail Spam Cleaner"
$Shortcut.Save()

Write-Host "OK: Desktop shortcut created -> $LnkPath" -ForegroundColor Green
Write-Host ""
Write-Host "Double-click 'Mail Spam Cleaner' on your Desktop to launch the app." -ForegroundColor Cyan
