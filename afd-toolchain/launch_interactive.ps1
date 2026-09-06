param(
    [string]$dosbox = 'C:\Program Files (x86)\DOSBox-0.74-3\DOSBox.exe',
    [string]$runConf = 'C:\Users\HP\Documents\GitHub\assembly-lowlevel\Assembly Language Dry Running Tool Project\afd-toolchain\run_afd.conf'
)

# 1. Kill old instances
Stop-Process -Name dosbox -Force -ErrorAction SilentlyContinue

# 2. Launch using ShellExecuteEx via .NET ProcessStartInfo
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $dosbox
$psi.Arguments = "-conf `"$runConf`""
$psi.UseShellExecute = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
$p = [System.Diagnostics.Process]::Start($psi)

# 3. Wait for window creation and force to foreground
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 250
    $proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) {
        Write-Host "Found window handle: $($proc.MainWindowHandle)"
        # Bring to front using WScript.Shell AppActivate
        $wsh = New-Object -ComObject WScript.Shell
        $wsh.AppActivate($proc.Id) | Out-Null
        break
    }
}

$finalProc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if ($finalProc) {
    Write-Host "DOSBox launched successfully: Id=$($finalProc.Id), Handle=$($finalProc.MainWindowHandle), Title='$($finalProc.MainWindowTitle)'"
} else {
    Write-Host "Failed to launch DOSBox"
}
