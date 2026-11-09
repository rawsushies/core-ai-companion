# COre: reads the Windows media session (what is playing) while a song card is open.
# Prints one JSON line per second. Read-only.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(5000); $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$lastKey = ''
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  $o = @{ none = $true }
  $s = $null; if ($mgr) { $s = $mgr.GetCurrentSession() }
  if ($s) {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $tl = $s.GetTimelineProperties(); $pi = $s.GetPlaybackInfo()
    $o = @{ title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; pos = [int64]$tl.Position.TotalMilliseconds; dur = [int64]$tl.EndTime.TotalMilliseconds; upd = $tl.LastUpdatedTime.ToUnixTimeMilliseconds(); playing = ([int]$pi.PlaybackStatus -eq 4); app = $s.SourceAppUserModelId }
    # Album art: read once per track (the thumbnail stream), at most 600 KB.
    $key = "$($p.Title)|$($p.Artist)"
    if ($p.Thumbnail -and $key -ne $lastKey) {
      $lastKey = $key
      try {
        $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $size = [uint32]$st.Size
        if ($size -gt 0 -and $size -lt 600000) {
          $rd = New-Object Windows.Storage.Streams.DataReader($st.GetInputStreamAt(0))
          $null = Await ($rd.LoadAsync($size)) ([uint32])
          $bytes = New-Object byte[] $size
          $rd.ReadBytes($bytes)
          $o.art = [Convert]::ToBase64String($bytes)
          $o.artType = $st.ContentType
        }
      } catch {}
    }
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}
