# dsh-notify -- Windows 11 toast renderer.
#
# This file is deliberately pure ASCII: every localized string arrives inside the
# base64 payload, which is decoded here as UTF-8. A .ps1 read by Windows
# PowerShell decodes as ANSI unless it carries a BOM, so keeping the source ASCII
# is what makes non-ASCII titles survive the trip.
#
# Contract:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -File toast.ps1 -PayloadB64 <base64 of a UTF-8 JSON object>
#
# The JSON object (all fields optional unless noted):
#   appId     string  AUMID used to post the toast        (default DSH's own)
#   title     string  first text line                     (required)
#   body      string  second text line
#   attribution string small footer line
#   tag       string  replaces an earlier toast with the same tag+group
#   group     string  see tag
#   launch    string  URI opened when the toast body is clicked
#   duration  string  "short" | "long"
#   scenario  string  "urgent" | "alarm" | "reminder" | "incomingcall" | ""
#   sound     string  "default" | "silent" | "alarm" | ... | a ms-winsoundevent URI
#   loop      bool    loop the sound (only meaningful with a scenario/looping sound)
#   logo      string  absolute path for the app-logo override image
#   hero      string  absolute path for the hero image
#   progress  object  { title, value, status } -- a progress bar on the toast
#   buttons   array   { content, arguments, activationType } entries
#   expireMinutes int removes the toast from Action Center after this long
#   dryRun    bool    build everything and create the notifier, but show nothing
#                     (the plugin's startup capability probe)
#   focusCheck object { pids } -- report which pid owns the foreground window and
#                     whether each given pid matches it, drawing nothing.
#   skipWhenFocused int -- draw nothing while this pid owns the foreground window.
#
# A toast carrying a tag and group that Action Center already holds replaces it,
# which is the only way an unpackaged process can retire one: the History API
# (`ToastNotificationManager.History`) is scoped to the caller's package identity,
# so from here it reports an empty history and refuses every Remove. The plugin
# therefore settles a finished request by re-drawing it under the same tag rather
# than by deleting it.
#
# Exit codes: 0 shown (or "ready" under dryRun), 1 payload invalid, 2 the platform
# refused the toast.

param(
  [Parameter(Mandatory = $true)][string]$PayloadB64
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 pipes stderr in the console code page; UTF-8 keeps the localized
# failure text readable in the Host's log.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Fail([int]$code, [string]$message) {
  [Console]::Error.WriteLine($message)
  exit $code
}

# An unpackaged toast cannot tell whether the user is already looking at the
# application, so the plugin asks Win32. Add-Type compiles C# on first use and
# costs a few hundred milliseconds, so the helper is defined here but only
# invoked by the payloads that actually ask about focus.
function Get-ForegroundPid {
  if (-not ('DshNotifyFocus' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class DshNotifyFocus {
  [DllImport("user32.dll")] private static extern System.IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
  public static uint Foreground() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid;
  }
}
'@ -ErrorAction Stop
  }
  return [DshNotifyFocus]::Foreground()
}

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
  $payload = $json | ConvertFrom-Json
} catch {
  Fail 1 "payload decode failed: $($_.Exception.Message)"
}

$appId = if ($payload.appId) { [string]$payload.appId } else { 'com.deepseek.dsh' }

# The focus probe answers two questions without drawing anything: which pid owns
# the foreground window, and whether a given set of pids matches it. Testing both
# directions is what makes the gate trustworthy -- a probe that answers "yes" to
# everything would silently swallow every notification.
if ($payload.focusCheck) {
  try {
    $foreground = Get-ForegroundPid
    $matches = @(
      foreach ($candidate in @($payload.focusCheck.pids)) { [int]$candidate -eq [int]$foreground }
    )
    # Walk up from a starting pid and report the chain. The Host is not always a
    # direct child of the window-owning process -- a launcher can sit between them --
    # so the caller needs the whole ancestry rather than one guessed pid.
    $ancestors = @()
    if ($payload.focusCheck.ancestorsOf) {
      $cursor = [int]$payload.focusCheck.ancestorsOf
      for ($depth = 0; $depth -lt 8 -and $cursor -gt 0; $depth++) {
        $ancestors += $cursor
        $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $cursor" -ErrorAction SilentlyContinue).ParentProcessId
        if ($null -eq $parent -or [int]$parent -eq $cursor -or [int]$parent -le 0) { break }
        $cursor = [int]$parent
      }
    }
    Write-Output (ConvertTo-Json -InputObject ([ordered]@{ foreground = $foreground; matches = $matches; ancestors = $ancestors }) -Compress)
    exit 0
  } catch {
    Fail 2 "focus check failed: $($_.Exception.Message)"
  }
}

$title = [string]$payload.title
if ([string]::IsNullOrWhiteSpace($title)) { Fail 1 'title is required' }

# Drawing is skipped while the named process owns the foreground window. A probe
# failure keeps the toast: missing a notification is worse than an extra one.
if ($payload.skipWhenFocused) {
  try {
    # One pid or a whole ancestry: the Host's window-owning ancestor is not
    # necessarily its direct parent.
    $foreground = [int](Get-ForegroundPid)
    if (@($payload.skipWhenFocused) -contains $foreground) {
      Write-Output 'focused'
      exit 0
    }
  } catch {
    [Console]::Error.WriteLine("focus probe failed, drawing anyway: $($_.Exception.Message)")
  }
}

function Esc([string]$text) {
  if ($null -eq $text) { return '' }
  return $text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

# A file path becomes a file:// URI that the toast renderer accepts.
function ImgSrc([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  if ($path -match '^[a-zA-Z]+://') { return $path }
  return 'file:///' + ($path -replace '\\', '/').TrimStart('/')
}

# Every Esc()/ImgSrc() result is hoisted into a plain variable before it is
# interpolated. Windows PowerShell 5.1's parser rejects the shorter nested form
# `$list.Add(('...' -f (Esc ([string]$payload.x))))`, and this script must parse
# identically under 5.1 and 7.x.
$attrs = New-Object Collections.Generic.List[string]
if ($payload.launch) {
  $launchText = Esc ([string]$payload.launch)
  $attrs.Add('activationType="protocol" launch="' + $launchText + '"')
}
if ($payload.duration -eq 'long' -or $payload.duration -eq 'short') {
  $attrs.Add('duration="' + [string]$payload.duration + '"')
}
if ($payload.scenario) {
  $scenarioText = Esc ([string]$payload.scenario)
  $attrs.Add('scenario="' + $scenarioText + '"')
}
# Expiry is a property on the toast object, not an XML attribute; see below.

$visual = New-Object Collections.Generic.List[string]
$logo = ImgSrc ([string]$payload.logo)
if ($logo) {
  $logoSrc = Esc $logo
  $visual.Add('<image placement="appLogoOverride" hint-crop="circle" src="' + $logoSrc + '"/>')
}
$hero = ImgSrc ([string]$payload.hero)
if ($hero) {
  $heroSrc = Esc $hero
  $visual.Add('<image placement="hero" src="' + $heroSrc + '"/>')
}
$titleText = Esc $title
$visual.Add('<text>' + $titleText + '</text>')
if ($payload.body) {
  $bodyText = Esc ([string]$payload.body)
  $visual.Add('<text>' + $bodyText + '</text>')
}
if ($payload.attribution) {
  $attributionText = Esc ([string]$payload.attribution)
  $visual.Add('<text placement="attribution">' + $attributionText + '</text>')
}

$progress = ''
if ($payload.progress) {
  $progress = '<progress'
  if ($payload.progress.title) {
    $progressTitle = Esc ([string]$payload.progress.title)
    $progress += ' title="' + $progressTitle + '"'
  }
  if ($null -ne $payload.progress.value) {
    $progress += ' value="' + [string]$payload.progress.value + '"'
  }
  if ($payload.progress.status) {
    $progressStatus = Esc ([string]$payload.progress.status)
    $progress += ' status="' + $progressStatus + '"'
  }
  $progress += '/>'
}

$actions = ''
if ($payload.buttons -and $payload.buttons.Count -gt 0) {
  $rendered = foreach ($button in $payload.buttons) {
    $kind = if ($button.activationType) { [string]$button.activationType } else { 'protocol' }
    $buttonContent = Esc ([string]$button.content)
    $buttonKind = Esc $kind
    $buttonArguments = Esc ([string]$button.arguments)
    '<action content="' + $buttonContent + '" activationType="' + $buttonKind + '" arguments="' + $buttonArguments + '"/>'
  }
  $actions = '<actions>' + ($rendered -join '') + '</actions>'
}

$audio = ''
if ($payload.sound) {
  $src = [string]$payload.sound
  if ($src -eq 'default') { $src = 'ms-winsoundevent:Notification.Default' }
  elseif ($src -eq 'silent') { $src = 'ms-winsoundevent:Notification.Silent' }
  elseif ($src -eq 'alarm') { $src = 'ms-winsoundevent:Notification.Looping.Alarm' }
  elseif ($src -eq 'im') { $src = 'ms-winsoundevent:Notification.IM' }
  elseif ($src -eq 'mail') { $src = 'ms-winsoundevent:Notification.Mail' }
  elseif ($src -eq 'reminder') { $src = 'ms-winsoundevent:Notification.Reminder' }
  elseif ($src -notmatch ':') { $src = 'ms-winsoundevent:Notification.' + $src }
  $loop = if ($payload.loop) { 'true' } else { 'false' }
  $soundSrc = Esc $src
  $audio = '<audio src="' + $soundSrc + '" loop="' + $loop + '"/>'
} elseif ($payload.loop) {
  $audio = '<audio loop="true"/>'
}

$xml = @"
<toast $($attrs -join ' ')>
  <visual>
    <binding template="ToastGeneric">
      $($visual -join "`n      ")
      $progress
    </binding>
  </visual>
  $actions
  $audio
</toast>
"@

try {
  $document = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]::new()
  $document.LoadXml($xml)
} catch {
  Fail 1 "toast XML rejected: $($_.Exception.Message)"
}

try {
  $toast = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]::new($document)
  if ($payload.tag) { $toast.Tag = [string]$payload.tag }
  if ($payload.group) { $toast.Group = [string]$payload.group }
  if ($payload.expireMinutes) {
    $toast.ExpirationTime = [DateTimeOffset]::UtcNow.AddMinutes([double]$payload.expireMinutes)
  }
  $notifier = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]::CreateToastNotifier($appId)
  if ($payload.dryRun) {
    Write-Output 'ready'
    exit 0
  }
  $notifier.Show($toast)
} catch {
  Fail 2 "show failed: $($_.Exception.Message)"
}

Write-Output 'shown'
exit 0
