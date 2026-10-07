# ASH PDF Studio: PDF -> Word document through Microsoft Word (PDF Reflow).
# Run: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pdf-to-docx.ps1 <in.pdf> <out.docx>
# Exit codes: 0 done, 2 Microsoft Word is not installed, 1 any other error (message on stderr).
# stdout: "OFFICE_PID <n>" once Word has started (the new WINWORD process), so the app can end it on timeout/cancel.
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
$m = [Type]::Missing
# Word's PDF Reflow asks "Word will now convert your PDF to an editable Word document..." even with
# DisplayAlerts off; hidden Word then waits for ever. DisableConvertPdfWarning = 1 turns that prompt off.
# The previous value of each key touched is restored (or the value removed) in finally.
$warningKeys = @{}
function Disable-PdfWarning([string]$ver) {
  if (-not $ver -or $warningKeys.ContainsKey($ver)) { return }
  $key = "HKCU:\Software\Microsoft\Office\$ver\Word\Options"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  $prev = (Get-ItemProperty -Path $key -Name 'DisableConvertPdfWarning' -ErrorAction SilentlyContinue).DisableConvertPdfWarning
  $warningKeys[$ver] = @{ Key = $key; Prev = $prev }
  New-ItemProperty -Path $key -Name 'DisableConvertPdfWarning' -Value 1 -PropertyType DWord -Force | Out-Null
}
function Get-OneLine([string]$s) { return ($s -replace '\s*[\r\n]+\s*', ' ').Trim() }
try {
  try { Unblock-File -LiteralPath $In } catch {} # the input is the app's own temp copy
  # Set before Word starts (it may read its options at start-up): the registered version, e.g. Word.Application.16 -> 16.0
  try {
    $curVer = (Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\Word.Application\CurVer' -ErrorAction Stop).'(default)'
    if ($curVer -match '\.(\d+)$') { Disable-PdfWarning "$($Matches[1]).0" }
  } catch {}
  $before = @(Get-Process -Name 'WINWORD' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  try { $word = New-Object -ComObject Word.Application } catch { [Console]::Error.WriteLine('Microsoft Word is not installed'); exit 2 }
  $started = @(Get-Process -Name 'WINWORD' -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  if ($started.Count -eq 1) { [Console]::Out.WriteLine("OFFICE_PID $($started[0].Id)"); [Console]::Out.Flush() }
  $word.Visible = $false
  $word.DisplayAlerts = 0 # wdAlertsNone
  Disable-PdfWarning $word.Version # the running Word's version, when CurVer was missing or differs
  # Documents.Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
  #                Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible)
  try {
    $doc = $word.Documents.Open($In, $false, $true, $false, '', $m, $false, $m, $m, $m, $m, $false)
  } catch {
    throw "Microsoft Word could not open this PDF. Open the PDF in Word yourself once (File > Open), then try again. ($(Get-OneLine $_.Exception.Message))"
  }
  $doc.SaveAs2($Out, 16) # wdFormatDocumentDefault (.docx)
  exit 0
} catch {
  [Console]::Error.WriteLine((Get-OneLine $_.Exception.Message))
  exit 1
} finally {
  if ($doc) { try { $doc.Close($false) | Out-Null } catch {} }
  if ($word) { try { $word.Quit() | Out-Null } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
  foreach ($w in $warningKeys.Values) {
    try {
      if ($null -eq $w.Prev) { Remove-ItemProperty -Path $w.Key -Name 'DisableConvertPdfWarning' -ErrorAction SilentlyContinue }
      else { New-ItemProperty -Path $w.Key -Name 'DisableConvertPdfWarning' -Value $w.Prev -PropertyType DWord -Force | Out-Null }
    } catch {}
  }
}
