# ASH PDF Studio: Word / Excel / PowerPoint file -> PDF through Microsoft Office.
# Run: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File office-to-pdf.ps1 <word|excel|powerpoint> <in> <out.pdf>
# <in> is the app's own temp copy of the user's file (short ASCII name, same extension).
# Exit codes: 0 done, 2 the Office application is not installed, 1 any other error (message on stderr).
# stdout: "OFFICE_PID <n>" once the application has started (its new process), so the app can end it on timeout/cancel.
param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$progIds = @{ word = 'Word.Application'; excel = 'Excel.Application'; powerpoint = 'PowerPoint.Application' }
$names = @{ word = 'Microsoft Word'; excel = 'Microsoft Excel'; powerpoint = 'Microsoft PowerPoint' }
$processNames = @{ word = 'WINWORD'; excel = 'EXCEL'; powerpoint = 'POWERPNT' }
if (-not $progIds.ContainsKey($Kind)) { [Console]::Error.WriteLine("Unknown kind: $Kind"); exit 1 }
$appObj = $null
$keepApp = $false
$prevAlerts = $null
$doc = $null
$m = [Type]::Missing
function Get-OneLine([string]$s) { return ($s -replace '\s*[\r\n]+\s*', ' ').Trim() }
function Get-OpenAdvice([string]$app, [string]$comMessage) {
  return "$app could not open this file. If it opens in Protected View or asks to repair, open it in $($app -replace '^Microsoft ', ''), save a copy, and try again. ($(Get-OneLine $comMessage))"
}
try {
  # Files from e-mail or the internet carry the Mark of the Web and open in Protected View, which
  # makes Open fail under automation. $In is a private copy, so unblocking it changes nothing of the user's.
  try { Unblock-File -LiteralPath $In } catch {}
  $before = @(Get-Process -Name $processNames[$Kind] -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  try { $appObj = New-Object -ComObject $progIds[$Kind] } catch { [Console]::Error.WriteLine("$($names[$Kind]) is not installed"); exit 2 }
  # Only a process that did not exist before (none when the user's PowerPoint was reused, then nothing is reported).
  $started = @(Get-Process -Name $processNames[$Kind] -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  if ($started.Count -eq 1) { [Console]::Out.WriteLine("OFFICE_PID $($started[0].Id)"); [Console]::Out.Flush() }
  switch ($Kind) {
    'word' {
      $appObj.Visible = $false
      $appObj.DisplayAlerts = 0
      # Documents.Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
      #                Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible)
      try { $doc = $appObj.Documents.Open($In, $false, $true, $false, '', $m, $false, $m, $m, $m, $m, $false) }
      catch { throw (Get-OpenAdvice $names.word $_.Exception.Message) }
      $doc.ExportAsFixedFormat($Out, 17) # wdExportFormatPDF
    }
    'excel' {
      $appObj.Visible = $false
      $appObj.DisplayAlerts = $false
      $appObj.AutomationSecurity = 3 # msoAutomationSecurityForceDisable: no macros, no macro prompt
      $appObj.EnableEvents = $false
      $appObj.AskToUpdateLinks = $false
      # Workbooks.Open(Filename, UpdateLinks, ReadOnly, Format, Password, WriteResPassword, IgnoreReadOnlyRecommended,
      #                Origin, Delimiter, Editable, Notify, Converter, AddToMru, Local, CorruptLoad)
      try {
        $doc = $appObj.Workbooks.Open($In, 0, $true, $m, $m, $m, $true, $m, $m, $false, $false, $m, $false)
      } catch {
        $first = $_.Exception.Message
        try { $doc = $appObj.Workbooks.Open($In, 0, $true, $m, $m, $m, $true, $m, $m, $false, $false, $m, $false, $m, 1) } # CorruptLoad = xlRepairFile
        catch { throw (Get-OpenAdvice $names.excel $first) }
      }
      $doc.ExportAsFixedFormat(0, $Out) # xlTypePDF, the whole workbook (all sheets)
    }
    'powerpoint' {
      # PowerPoint is single-instance: if the user already has presentations open, this is their PowerPoint.
      # Leave it running (never Quit it) and put their alert setting back afterwards.
      if ($appObj.Presentations.Count -gt 0) { $keepApp = $true; $prevAlerts = $appObj.DisplayAlerts }
      $appObj.DisplayAlerts = 1 # ppAlertsNone; PowerPoint refuses Visible = false, the window stays hidden through WithWindow
      try { $doc = $appObj.Presentations.Open($In, -1, 0, 0) } # ReadOnly, Untitled:=false, WithWindow:=false
      catch { throw (Get-OpenAdvice $names.powerpoint $_.Exception.Message) }
      $doc.SaveAs($Out, 32) # ppSaveAsPDF
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine((Get-OneLine $_.Exception.Message))
  exit 1
} finally {
  if ($doc) { try { if ($Kind -eq 'excel') { $doc.Close($false) } elseif ($Kind -eq 'word') { $doc.Close($false) } else { $doc.Close() } } catch {} }
  if ($appObj -and $keepApp) { try { $appObj.DisplayAlerts = $prevAlerts } catch {} }
  if ($appObj) {
    $quit = -not $keepApp
    # PowerPoint is single-instance: a presentation the user opened during the run lands in this PowerPoint.
    # Quit only when nothing is left open after closing ours.
    if ($quit -and $Kind -eq 'powerpoint') { try { $quit = ($appObj.Presentations.Count -eq 0) } catch { $quit = $false } }
    if ($quit) { try { $appObj.Quit() | Out-Null } catch {} }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($appObj)
  }
}
