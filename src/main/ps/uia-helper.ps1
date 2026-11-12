# COre UI Automation helper (Windows). Reads one JSON request per line on
# stdin and writes one JSON response per line on stdout. It only inspects and
# operates controls the desktop agent asks for; which actions are allowed and
# whether the user approved them is decided in COre (agent.js), not here.
#
# Requests: { id, op, ... }
#   windows                      top-level windows: name, process, bounds
#   snapshot { target, depth, max }  controls of a window ('foreground' or a window id)
#   invoke   { el }              press a control (Invoke, Toggle, Select, Expand)
#   setvalue { el, text }        set the text of an edit field (ValuePattern)
#   focus    { el }              keyboard focus
#   expand   { el } / collapse   open or close a menu, combo box or tree item
#   scroll   { el, dir }         scroll a scrollable control up/down
#   activate { el }              bring a window to the front
#   value    { el }              read a control's current value/name
# Element ids come from the latest windows/snapshot call.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# Win32 controls (Edit, Button, CheckBox...) need the client-side providers;
# without them they show up as plain "Pane" with no patterns.
$script:providerStatus = 'not registered'
try {
  $asm = [System.Reflection.Assembly]::LoadWithPartialName('UIAutomationClientsideProviders')
  if ($asm -eq $null) { throw 'assembly not found' }
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviderAssembly($asm.GetName())
  $script:providerStatus = 'registered'
} catch { $script:providerStatus = "failed: $($_.Exception.Message)" }
Add-Type -Namespace CoreUia -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, System.Text.StringBuilder lParam);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
'@

# MSAA (oleacc): role, checked state and default action of Win32 controls,
# reliable even for owner-drawn framework buttons.
try {
  Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CoreMsaa {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object acc);
  static Accessibility.IAccessible Get(IntPtr h) {
    Guid g = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object o;
    if (AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref g, out o) != 0) return null;
    return o as Accessibility.IAccessible;
  }
  public static int Role(IntPtr h) { try { var a = Get(h); return a == null ? 0 : Convert.ToInt32(a.get_accRole(0)); } catch { return 0; } }
  public static int State(IntPtr h) { try { var a = Get(h); return a == null ? 0 : Convert.ToInt32(a.get_accState(0)); } catch { return 0; } }
  public static bool Default(IntPtr h) { try { var a = Get(h); if (a == null) return false; a.accDoDefaultAction(0); return true; } catch { return false; } }
}
'@
  $script:msaa = $true
} catch { $script:msaa = $false }

$AE = [System.Windows.Automation.AutomationElement]
$Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:cache = @{}
$script:nextId = 0

function Get-Rect($e) {
  $r = $e.Current.BoundingRectangle
  if ($r.IsEmpty -or [double]::IsInfinity($r.Width)) { return $null }
  return [ordered]@{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
}

function Get-PatternNames($e) {
  $out = @()
  foreach ($p in $e.GetSupportedPatterns()) { $out += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '') }
  return ,$out
}

function Add-Element($e) {
  $script:nextId++
  $script:cache[$script:nextId] = $e
  return $script:nextId
}

# Win32 fallback (like pywinauto's win32 backend): standard controls that expose
# no UIA patterns are still operable through their window handle.
function Get-Win32Kind($e) {
  $h = [IntPtr]$e.Current.NativeWindowHandle
  if ($h -eq [IntPtr]::Zero) { return $null }
  $cls = [string]$e.Current.ClassName
  if ($script:msaa) {
    switch ([CoreMsaa]::Role($h)) {
      0x2B { return 'button' }   # ROLE_SYSTEM_PUSHBUTTON
      0x2C { return 'check' }    # ROLE_SYSTEM_CHECKBUTTON
      0x2D { return 'radio' }    # ROLE_SYSTEM_RADIOBUTTON
      0x2A { return 'edit' }     # ROLE_SYSTEM_TEXT (editable)
      0x29 { return 'text' }     # ROLE_SYSTEM_STATICTEXT
    }
  }
  if ($cls -match 'EDIT|RichEdit') { return 'edit' }
  if ($cls -match 'BUTTON') {
    # WM_GETDLGCODE tells push buttons, radio buttons and check boxes apart even
    # when the style bits don't (owner-drawn / framework buttons).
    $code = [int][CoreUia.Native]::SendMessage($h, 0x0087, [IntPtr]::Zero, [IntPtr]::Zero)
    $style = [CoreUia.Native]::GetWindowLong($h, -16) -band 0xF
    if (($code -band 0x40) -or $style -in 4, 9) { return 'radio' }
    if ($code -band 0x30) { return 'button' }   # default / non-default push button
    if (($code -band 0x2000) -or $style -in 2, 3, 5, 6) { return 'check' }
    return 'button'
  }
  if ($cls -match 'STATIC') { return 'text' }
  return $null
}

function Get-Win32Text($e) {
  $h = [IntPtr]$e.Current.NativeWindowHandle
  $len = [int][CoreUia.Native]::SendMessage($h, 0x000E, [IntPtr]::Zero, [IntPtr]::Zero) # WM_GETTEXTLENGTH
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][CoreUia.Native]::SendMessage($h, 0x000D, [IntPtr]($len + 1), $sb) # WM_GETTEXT
  return $sb.ToString()
}

function Describe($e, $depth) {
  $c = $e.Current
  $o = [ordered]@{
    id = (Add-Element $e)
    type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    name = $c.Name
    aid = $c.AutomationId
    cls = $c.ClassName
    enabled = $c.IsEnabled
    focused = $c.HasKeyboardFocus
    bounds = (Get-Rect $e)
    depth = $depth
    patterns = (Get-PatternNames $e)
  }
  if ($o.patterns.Count -eq 0 -or $o.type -eq 'Pane') {
    $k = Get-Win32Kind $e
    if ($k -eq 'edit') { $o.type = 'Edit'; $o.patterns = @('Value', 'Win32'); try { $o.value = Get-Win32Text $e } catch {} }
    elseif ($k -eq 'button') { $o.type = 'Button'; $o.patterns = @('Invoke', 'Win32') }
    elseif ($k -eq 'check' -or $k -eq 'radio') {
      $o.type = $(if ($k -eq 'check') { 'CheckBox' } else { 'RadioButton' }); $o.patterns = @('Toggle', 'Win32')
      $hw = [IntPtr]$e.Current.NativeWindowHandle
      $checked = $false
      if ($script:msaa) { $checked = ([CoreMsaa]::State($hw) -band 0x10) -ne 0 }   # STATE_SYSTEM_CHECKED
      if (-not $checked) { $checked = [int][CoreUia.Native]::SendMessage($hw, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero) -eq 1 } # BM_GETCHECK
      $o.toggle = $(if ($checked) { 'On' } else { 'Off' })
    }
    elseif ($k -eq 'text') { $o.type = 'Text'; try { $t = Get-Win32Text $e; if ($t) { $o.name = $t } } catch {} }
  }
  try {
    $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $v = [string]$vp.Current.Value
    if ($v.Length -gt 300) { $v = $v.Substring(0, 300) }
    $o.value = $v
  } catch {}
  try {
    $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $o.toggle = [string]$tp.Current.ToggleState
  } catch {}
  try {
    $xp = $e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $o.expanded = [string]$xp.Current.ExpandCollapseState
  } catch {}
  return $o
}

$script:walkErrors = New-Object System.Collections.ArrayList
function Walk($root, $maxDepth, $max) {
  $script:walkErrors.Clear()
  $list = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push(@($root, 0))
  while ($stack.Count -gt 0 -and $list.Count -lt $max) {
    $item = $stack.Pop()
    $e = $item[0]
    $d = $item[1]
    # Offscreen controls are kept (marked): some desktops, like remote or
    # headless sessions, report everything offscreen. The outline decides.
    try {
      $o = Describe $e $d
      try { if ($e.Current.IsOffscreen) { $o.offscreen = $true } } catch {}
      [void]$list.Add($o)
    } catch { [void]$script:walkErrors.Add("describe: $($_.Exception.Message)"); continue }
    if ($d -lt $maxDepth) {
      $kids = New-Object System.Collections.ArrayList
      try {
        $found = $e.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition)
        foreach ($k in $found) { if ($kids.Count -ge 300) { break }; [void]$kids.Add($k) }
      } catch { [void]$script:walkErrors.Add("FindAll: $($_.Exception.Message)") }
      if ($kids.Count -eq 0) {
        foreach ($w in @($Walker, [System.Windows.Automation.TreeWalker]::RawViewWalker)) {
          try {
            $ch = $w.GetFirstChild($e)
            while ($ch -ne $null -and $kids.Count -lt 300) { [void]$kids.Add($ch); $ch = $w.GetNextSibling($ch) }
          } catch { [void]$script:walkErrors.Add("walker: $($_.Exception.Message)") }
          if ($kids.Count -gt 0) { break }
        }
      }
      for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($d + 1))) }
    }
  }
  return ,$list.ToArray()
}

function Get-ProcessName($procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-Windows() {
  $script:cache = @{}
  $wins = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $fg = [CoreUia.Native]::GetForegroundWindow().ToInt64()
  $out = @()
  foreach ($w in $wins) {
    try {
      $c = $w.Current
      if (-not $c.Name) { continue }
      $out += [ordered]@{
        id = (Add-Element $w); name = $c.Name; cls = $c.ClassName; pid = $c.ProcessId
        process = (Get-ProcessName $c.ProcessId); bounds = (Get-Rect $w)
        handle = $c.NativeWindowHandle; foreground = ([int64]$c.NativeWindowHandle -eq $fg)
      }
    } catch {}
  }
  return ,$out
}

function Get-El($req) {
  $e = $script:cache[[int]$req.el]
  if ($e -eq $null) { throw "Unknown element $($req.el): take a new snapshot." }
  return $e
}

function Try-Pattern($e, $pattern) {
  try { return $e.GetCurrentPattern($pattern) } catch { return $null }
}

function Handle($req) {
  switch ($req.op) {
    'ping' { return 'pong' }
    'windows' { return @{ windows = (Get-Windows) } }
    'snapshot' {
      $depth = if ($req.depth) { [int]$req.depth } else { 12 }
      $max = if ($req.max) { [int]$req.max } else { 300 }
      if ($req.target -and $req.target -ne 'foreground') {
        $root = Get-El @{ el = $req.target }
      } else {
        $h = [CoreUia.Native]::GetForegroundWindow()
        if ($h -eq [IntPtr]::Zero) { throw 'No foreground window.' }
        $root = $AE::FromHandle($h)
      }
      $keep = $script:cache
      $script:cache = @{}
      foreach ($k in $keep.Keys) { if ($keep[$k] -eq $root) { $script:cache[$k] = $root } }
      $c = $root.Current
      $win = [ordered]@{ name = $c.Name; cls = $c.ClassName; pid = $c.ProcessId; process = (Get-ProcessName $c.ProcessId); bounds = (Get-Rect $root); handle = $c.NativeWindowHandle }
      $els = Walk $root $depth $max
      $errs = @($script:walkErrors | Select-Object -First 5)
      if ($script:providerStatus -ne 'registered') { $errs += "client-side providers $($script:providerStatus)" }
      return @{ window = $win; elements = $els; errors = $errs }
    }
    'invoke' {
      $e = Get-El $req
      if (-not $e.Current.IsEnabled) { throw 'That control is disabled.' }
      $p = Try-Pattern $e ([System.Windows.Automation.InvokePattern]::Pattern)
      if ($p) { $p.Invoke(); return 'invoked' }
      $p = Try-Pattern $e ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($p) { $p.Toggle(); return 'toggled' }
      $p = Try-Pattern $e ([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($p) { $p.Select(); return 'selected' }
      $p = Try-Pattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if ($p) {
        if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $p.Collapse() } else { $p.Expand() }
        return 'expanded'
      }
      $k = Get-Win32Kind $e
      if ($k -in 'button', 'check', 'radio') {
        $hw = [IntPtr]$e.Current.NativeWindowHandle
        if (-not ($script:msaa -and [CoreMsaa]::Default($hw))) { [void][CoreUia.Native]::SendMessage($hw, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) } # MSAA default action, else BM_CLICK
        return $(if ($k -eq 'button') { 'invoked' } else { 'toggled' })
      }
      throw 'NO_PATTERN: this control has no press action; click its centre instead.'
    }
    'setvalue' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $p) {
        if ((Get-Win32Kind $e) -eq 'edit') { [void][CoreUia.Native]::SendMessage([IntPtr]$e.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, [string]$req.text); return 'set' } # WM_SETTEXT
        throw 'NO_PATTERN: this control does not take text; focus it and type instead.'
      }
      if ($p.Current.IsReadOnly) { throw 'That field is read-only.' }
      $p.SetValue([string]$req.text)
      return 'set'
    }
    'value' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      $v = $null
      if ($p) { $v = [string]$p.Current.Value } elseif ((Get-Win32Kind $e) -eq 'edit') { $v = Get-Win32Text $e }
      return @{ value = $v; name = $e.Current.Name }
    }
    'focus' { $e = Get-El $req; $e.SetFocus(); return 'focused' }
    'expand' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if (-not $p) { throw 'NO_PATTERN: this control does not expand.' }
      $p.Expand(); return 'expanded'
    }
    'collapse' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      if (-not $p) { throw 'NO_PATTERN: this control does not collapse.' }
      $p.Collapse(); return 'collapsed'
    }
    'scroll' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ScrollPattern]::Pattern)
      if (-not $p) { throw 'NO_PATTERN: this control does not scroll.' }
      $amt = if ($req.dir -eq 'up') { [System.Windows.Automation.ScrollAmount]::LargeDecrement } else { [System.Windows.Automation.ScrollAmount]::LargeIncrement }
      $p.ScrollVertical($amt); return 'scrolled'
    }
    'activate' {
      $e = Get-El $req
      $h = [IntPtr]$e.Current.NativeWindowHandle
      if ($h -eq [IntPtr]::Zero) { throw 'Not a window.' }
      [void][CoreUia.Native]::ShowWindow($h, 9)
      [void][CoreUia.Native]::SetForegroundWindow($h)
      return 'activated'
    }
    default { throw "Unknown op $($req.op)" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if (-not $line.Trim()) { continue }
  $req = $null
  try {
    $req = $line | ConvertFrom-Json
    $res = Handle $req
    $out = @{ id = $req.id; ok = $true; result = $res }
  } catch {
    $rid = 0
    if ($req -ne $null) { $rid = $req.id }
    $out = @{ id = $rid; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
