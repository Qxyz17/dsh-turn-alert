# DSH desktop notification helper (Windows).
#
# Inputs arrive through environment variables so the command line stays free of
# quoting hazards:
#   DSH_NOTIFY_KIND    done | error | question
#   DSH_NOTIFY_TITLE   short headline
#   DSH_NOTIFY_BODY    one-line detail (optional)
#   DSH_NOTIFY_AUMID   AppUserModelID to post the toast as (empty -> tray balloon)
#   DSH_NOTIFY_SOUND   0 disables the built-in sound
#
# Primary path: a WinRT toast posted as the DeepSeek Harness app, so it lands in
# the Windows notification center with the app's own identity and icon.
# Fallback path: a tray balloon for setups where that AUMID is not registered.
$ErrorActionPreference = 'Stop'

$kind = [string]$env:DSH_NOTIFY_KIND
$title = [string]$env:DSH_NOTIFY_TITLE
$body = [string]$env:DSH_NOTIFY_BODY
$aumid = [string]$env:DSH_NOTIFY_AUMID
$soundOn = $env:DSH_NOTIFY_SOUND -ne '0'

if (-not $title) { $title = 'DeepSeek Harness' }
if ($body.Length -gt 220) { $body = $body.Substring(0, 217) + '...' }

# Windows built-in scheme sounds; no custom audio assets are shipped.
$sound = [System.Media.SystemSounds]::Asterisk
$toastDuration = 'short'
$balloonMs = 6000

switch ($kind) {
  'error' {
    $sound = [System.Media.SystemSounds]::Hand
    $toastDuration = 'long'
    $balloonMs = 9000
  }
  'question' {
    $sound = [System.Media.SystemSounds]::Exclamation
    $toastDuration = 'long'
    $balloonMs = 9000
  }
}

function Show-Toast {
  if (-not $aumid) { return $false }
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $safeTitle = [System.Security.SecurityElement]::Escape($title)
    $safeBody = [System.Security.SecurityElement]::Escape($body)
    $inner = "<text>$safeTitle</text>"
    if ($safeBody) { $inner += "<text>$safeBody</text>" }
    $xml = "<toast duration=""$toastDuration""><visual><binding template=""ToastGeneric"">$inner</binding></visual><audio silent=""true""/></toast>"
    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)
    $notification = New-Object Windows.UI.Notifications.ToastNotification $document
    $notifier.Show($notification)
    return $true
  }
  catch {
    return $false
  }
}

if (Show-Toast) {
  if ($soundOn) { $sound.Play() }
  # Keep the process alive only long enough for the asynchronous sound to start.
  Start-Sleep -Milliseconds 900
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = [System.Drawing.SystemIcons]::Information
$tip = [System.Windows.Forms.ToolTipIcon]::Info
switch ($kind) {
  'error' {
    $icon = [System.Drawing.SystemIcons]::Error
    $tip = [System.Windows.Forms.ToolTipIcon]::Error
  }
  'question' {
    $icon = [System.Drawing.SystemIcons]::Question
    $tip = [System.Windows.Forms.ToolTipIcon]::Warning
  }
}

$balloon = New-Object System.Windows.Forms.NotifyIcon
try {
  $balloon.Icon = $icon
  $balloon.Text = 'DeepSeek Harness'
  $balloon.Visible = $true
  $balloon.ShowBalloonTip($balloonMs, $title, $body, $tip)
  if ($soundOn) { $sound.Play() }
  # The owning process must outlive the balloon so the shell can render it.
  Start-Sleep -Milliseconds ($balloonMs + 400)
}
finally {
  $balloon.Visible = $false
  $balloon.Dispose()
}
