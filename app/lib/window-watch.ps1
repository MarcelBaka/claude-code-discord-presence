# Obserwator okien: dla każdego PID sesji Claude sprawdza, czy proces-rodzic
# (aplikacja Claude desktop) ma widoczne okno najwyższego poziomu.
# Wypisuje co ~1,5 s jedną linię JSON: {"<pid sesji>": true|false}.
# Kończy się sam, gdy zniknie proces demona.
param([int]$DaemonPid, [string]$PidFile)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CdpWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public static HashSet<uint> VisiblePids() {
    var s = new HashSet<uint>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0 && GetWindow(h, 4) == IntPtr.Zero) {
        int cloaked = 0; DwmGetWindowAttribute(h, 14, out cloaked, 4);
        if (cloaked == 0) { uint p; GetWindowThreadProcessId(h, out p); s.Add(p); }
      }
      return true;
    }, IntPtr.Zero);
    return s;
  }
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)

# Which tab of the Claude desktop app is shown: "code" (Claude Code), "chat" (regular
# Claude) or "unknown". Read from the page document in the window's accessibility tree:
# in the Code tab its name ends with " - Claude Code". Only the mode leaves this script,
# never the conversation title.
function Get-AppMode([IntPtr]$hwnd) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    # The window can hold several documents: the app's own shell (file:///…/index.html,
    # no name) and the claude.ai page. Decide from the claude.ai page; skip the shell.
    $mode = 'unknown'
    $script:appTitle = ''
    foreach ($doc in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)) {
      $name = [string]$doc.Current.Name
      $url = ''
      try { $url = [string]$doc.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
      if ($url -match '^file:') { continue }
      if ($name -match ' - Claude Code$' -or $url -match '^https://claude\.ai/(epitaxy|code)\b') {
        # the open session's title: the daemon matches it to Claude's own session names
        # to show the session you are looking at (kept in memory only, never sent or logged)
        if ($name -match '^(.+) - Claude Code$') { $script:appTitle = $Matches[1] }
        return 'code'
      }
      if ($url -match '^https://claude\.ai/' -or $name -match ' - Claude$' -or $name -eq 'Claude') { $mode = 'chat' }
    }
    return $mode
  } catch { return 'unknown' }
}

# JSON string with every non-ASCII character escaped – the console encoding then cannot
# garble Polish (or any other) characters on the way to Node
function ConvertTo-AsciiJson([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($ch in $s.ToCharArray()) {
    $c = [int]$ch
    if ($ch -eq '"') { [void]$sb.Append('\"') }
    elseif ($ch -eq '\') { [void]$sb.Append('\\') }
    elseif ($c -lt 32 -or $c -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $c)) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

$script:appTitle = ''
$parents = @{}
$appPid = 0
while ($true) {
  if (-not (Get-Process -Id $DaemonPid)) { exit }
  $pids = @()
  if (Test-Path -LiteralPath $PidFile) { $pids = @(((Get-Content -LiteralPath $PidFile -Raw) -split ',') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
  $vis = [CdpWin]::VisiblePids()
  $parts = @()
  foreach ($p in $pids) {
    if (-not $parents.ContainsKey($p)) {
      # The app may start a session through helper claude.exe processes (session ->
      # helper -> window), so collect the parent and, while they are claude.exe too,
      # its ancestors - any of them with a visible window means the window is open.
      $anc = @()
      $pp = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").ParentProcessId
      for ($i = 0; $pp -and $i -lt 5; $i++) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$pp"
        # never step out of the app (explorer.exe always has a visible window)
        if ($i -gt 0 -and (-not $pr -or $pr.Name -ne 'claude.exe')) { break }
        $anc += [uint32]$pp
        if (-not $pr) { break }
        $pp = $pr.ParentProcessId
      }
      if ($anc.Count) { $parents[$p] = $anc }
    }
    if ($parents.ContainsKey($p)) {
      $open = $false
      foreach ($a in $parents[$p]) { if ($vis.Contains($a)) { $open = $true; break } }
      $parts += ('"{0}":{1}' -f $p, $(if ($open) { 'true' } else { 'false' }))
    }
  }

  # the Claude desktop app's main window (not the claude.exe Claude Code CLI processes)
  $app = $null
  if ($appPid) { $app = Get-Process -Id $appPid; if ($app -and $app.ProcessName -ne 'claude') { $app = $null } }
  if (-not $app -or $app.MainWindowHandle -eq 0) {
    $cand = Get-Process -Name claude | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notmatch '[\\/]claude-code[\\/]' } | Select-Object -First 1
    if ($cand) { $app = $cand; $appPid = $cand.Id }
  }
  $appVisible = $false; $mode = 'unknown'
  if ($app -and $app.MainWindowHandle -ne 0 -and $vis.Contains([uint32]$app.Id)) {
    $appVisible = $true
    $mode = Get-AppMode $app.MainWindowHandle
  }
  $title = ''
  if ($appVisible -and $mode -eq 'code' -and $script:appTitle) { $title = ',"title":' + (ConvertTo-AsciiJson $script:appTitle) }
  $json = '{"vis":{' + ($parts -join ',') + '},"app":{"visible":' + $(if ($appVisible) { 'true' } else { 'false' }) + ',"mode":"' + $mode + '"' + $title + '}}'
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1500
}
