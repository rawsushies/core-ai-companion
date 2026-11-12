# COre command launcher (Windows): runs one command inside a Job Object.
#   powershell -NoProfile -NonInteractive -File job-run.ps1 -Cwd <dir> -MemoryMB 1024 -MaxProcs 32 -Argv <base64 of a JSON array: program, args...>
# (argv travels as one base64 value so arguments that start with '-' are never
# taken for launcher parameters by Windows PowerShell's binder)
# Limits: the whole process tree is killed when this launcher exits (COre kills
# it on timeout, Stop or emergency stop); at most MaxProcs processes; a memory
# cap per process; no clipboard, desktop switching, system-setting changes,
# global atoms or logoff/shutdown. Output is passed through. The launcher only
# enforces limits; which commands may run is decided in COre (agentTools.js).
# With -Isolate the command also runs in a Windows AppContainer
# (appcontainer.cs): it can read only system folders and the folders granted
# here (Roots read-write, the program's folder read-execute), and has no
# network. If the container cannot be set up the command is refused, never run
# with weaker isolation.
param(
  [string]$Cwd = '.',
  [int]$MemoryMB = 1024,
  [int]$MaxProcs = 32,
  [string]$Argv = '',
  [string]$Roots = '',     # base64 JSON array of folders the command may write (with -Isolate)
  [switch]$Isolate         # run the command in the COre AppContainer (no profile files, no network)
)
$ErrorActionPreference = 'Stop'
try { $Rest = @((ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Argv)))) | ForEach-Object { [string]$_ }) } catch { $Rest = @() }
if ($Rest.Count -lt 1) { [Console]::Error.WriteLine('job-run: no command'); exit 2 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CoreJob {
  [StructLayout(LayoutKind.Sequential)] public struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct EXT { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] public struct UI { public uint UIRestrictionsClass; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref UI info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  public static IntPtr Make(int memoryMB, int maxProcs) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed " + Marshal.GetLastWin32Error());
    EXT e = new EXT();
    // KILL_ON_JOB_CLOSE 0x2000 | ACTIVE_PROCESS 0x8 | PROCESS_MEMORY 0x100 | DIE_ON_UNHANDLED_EXCEPTION 0x400 | PRIORITY_CLASS 0x20
    e.Basic.LimitFlags = 0x2000 | 0x8 | 0x100 | 0x400 | 0x20;
    e.Basic.ActiveProcessLimit = (uint)maxProcs;
    e.Basic.PriorityClass = 0x4000; // BELOW_NORMAL
    e.ProcessMemoryLimit = new UIntPtr((ulong)memoryMB * 1024UL * 1024UL);
    if (!SetInformationJobObject(job, 9, ref e, Marshal.SizeOf(typeof(EXT)))) throw new Exception("job limits failed " + Marshal.GetLastWin32Error());
    UI u = new UI();
    // HANDLES 1 | READCLIPBOARD 2 | WRITECLIPBOARD 4 | SYSTEMPARAMETERS 8 | DISPLAYSETTINGS 0x10 | GLOBALATOMS 0x20 | DESKTOP 0x40 | EXITWINDOWS 0x80
    u.UIRestrictionsClass = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80;
    if (!SetInformationJobObject(job, 4, ref u, Marshal.SizeOf(typeof(UI)))) throw new Exception("job UI limits failed " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("could not join the job " + Marshal.GetLastWin32Error());
    return job;
  }
}
'@

try { $script:job = [CoreJob]::Make($MemoryMB, $MaxProcs) } catch { [Console]::Error.WriteLine("job-run: $($_.Exception.Message)"); exit 3 }

# From here every process started (and their children) is inside the job.
$quoted = foreach ($a in ($Rest | Select-Object -Skip 1)) { if ($a -eq '' -or $a -match '[\s"]') { '"' + ($a -replace '"', '\"') + '"' } else { $a } }
$workDir = (Resolve-Path -LiteralPath $Cwd).Path

if ($Isolate) {
  try {
    Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'appcontainer.cs'))
    $sid = [CoreBox]::Sid()
    $rootList = @()
    if ($Roots) { $rootList = @((ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Roots)))) | ForEach-Object { [string]$_ }) }
    # Grant the container exactly these folders (an ACE for the container SID only; nothing else changes).
    # Granted once per folder: re-granting would re-walk every file below it.
    foreach ($r in $rootList) {
      if (-not (Test-Path -LiteralPath $r)) { continue }
      $acl = (& icacls.exe $r 2>$null) -join "`n"
      if ($acl -match [regex]::Escape($sid) -or $acl -match 'COre\.AgentSandbox') { continue }
      & icacls.exe $r /grant "*${sid}:(OI)(CI)M" /Q | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "could not grant $r" }
    }
    # (No grants on parent folders: changing a folder's ACL makes Windows
    # re-apply inheritance to everything below it, which can take minutes.)
    # Node: do not resolve the main script's real path (needs the drive root).
    $env:NODE_OPTIONS = ("$env:NODE_OPTIONS --preserve-symlinks-main").Trim()
    $prog = $Rest[0]
    if (-not [IO.Path]::IsPathRooted($prog)) { $c = Get-Command $prog -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $prog = $c.Source } }
    $progDir = Split-Path -Parent $prog
    $sys = $env:SystemRoot
    if ($progDir -and (Test-Path -LiteralPath $progDir) -and -not ($sys -and $progDir.StartsWith($sys, [StringComparison]::OrdinalIgnoreCase))) {
      if (-not ((& icacls.exe $progDir 2>$null) -join "`n" -match ([regex]::Escape($sid) + '|COre\.AgentSandbox'))) { & icacls.exe $progDir /grant "*${sid}:(OI)(CI)RX" /Q | Out-Null }
    }
    $line = ((@('"' + $prog + '"') + @($quoted)) -join ' ')
    $code = [CoreBox]::Run($line, $workDir)
  } catch { [Console]::Error.WriteLine("job-run: sandbox refused: $($_.Exception.Message)"); exit 4 }
  exit $code
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Rest[0]
$psi.Arguments = ($quoted -join ' ')
$psi.WorkingDirectory = $workDir
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
try { $p = [System.Diagnostics.Process]::Start($psi) } catch { [Console]::Error.WriteLine("could not start: $($_.Exception.Message)"); exit 127 }
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
$p.WaitForExit()
[Console]::Out.Write($out.Result)
[Console]::Error.Write($err.Result)
exit $p.ExitCode
