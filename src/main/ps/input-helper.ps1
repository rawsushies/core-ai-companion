# COre desktop agent: performs approved clicks and key presses (SendInput).
# Reads one JSON command per line from COre; runs only while an agent task you started is active.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CoreInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT M(uint f, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = f; i.u.mi.mouseData = data; return i; }
  public static void Init() { SetProcessDPIAware(); }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Click(int x, int y, string b, bool dbl) {
    SetCursorPos(x, y); uint d = 2, u = 4; if (b == "right") { d = 8; u = 16; } else if (b == "middle") { d = 32; u = 64; }
    for (int n = 0; n < (dbl ? 2 : 1); n++) { Send(M(d, 0)); Send(M(u, 0)); }
  }
  public static void Wheel(int clicks) { Send(M(0x0800, unchecked((uint)(-clicks * 120)))); }
  public static void Key(ushort vk, bool up) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? 2u : 0u; Send(i); }
  public static void Char(char c) { foreach (uint f in new uint[] { 4u, 6u }) { var i = new INPUT(); i.type = 1; i.u.ki.wScan = c; i.u.ki.dwFlags = f; Send(i); } }
}
"@
[CoreInput]::Init()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'move' { [CoreInput]::Move([int]$c.x, [int]$c.y) }
      'click' { [CoreInput]::Click([int]$c.x, [int]$c.y, [string]$c.button, [bool]$c.double) }
      'wheel' { if ($c.x -ne $null) { [CoreInput]::Move([int]$c.x, [int]$c.y) }; [CoreInput]::Wheel([int]$c.dy) }
      'type' { foreach ($ch in ([string]$c.text).ToCharArray()) { [CoreInput]::Char($ch); Start-Sleep -Milliseconds 8 } }
      'key' { foreach ($vk in $c.down) { [CoreInput]::Key([uint16]$vk, $false) }; [array]::Reverse($c.down); foreach ($vk in $c.down) { [CoreInput]::Key([uint16]$vk, $true) } }
    }
    [Console]::Out.WriteLine('ok')
  } catch { [Console]::Out.WriteLine('error') }
  [Console]::Out.Flush()
}
