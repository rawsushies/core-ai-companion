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
Add-Type -Namespace CoreUia -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@

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

function Walk($root, $maxDepth, $max) {
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
    } catch { continue }
    if ($d -lt $maxDepth) {
      $kids = New-Object System.Collections.ArrayList
      try {
        $ch = $Walker.GetFirstChild($e)
        while ($ch -ne $null -and $kids.Count -lt 300) { [void]$kids.Add($ch); $ch = $Walker.GetNextSibling($ch) }
      } catch {}
      # Some hosts (XAML islands) show nothing in the control view: try the raw view.
      if ($kids.Count -eq 0) {
        try {
          $raw = [System.Windows.Automation.TreeWalker]::RawViewWalker
          $ch = $raw.GetFirstChild($e)
          while ($ch -ne $null -and $kids.Count -lt 300) { [void]$kids.Add($ch); $ch = $raw.GetNextSibling($ch) }
        } catch {}
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
      return @{ window = $win; elements = (Walk $root $depth $max) }
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
      throw 'NO_PATTERN: this control has no press action; click its centre instead.'
    }
    'setvalue' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $p) { throw 'NO_PATTERN: this control does not take text; focus it and type instead.' }
      if ($p.Current.IsReadOnly) { throw 'That field is read-only.' }
      $p.SetValue([string]$req.text)
      return 'set'
    }
    'value' {
      $e = Get-El $req
      $p = Try-Pattern $e ([System.Windows.Automation.ValuePattern]::Pattern)
      return @{ value = $(if ($p) { [string]$p.Current.Value } else { $null }); name = $e.Current.Name }
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
