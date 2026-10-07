# ASH PDF Studio: PDF -> Word document through Microsoft Word (PDF Reflow).
# Run: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pdf-to-docx.ps1 <in.pdf> <out.docx>
# Exit codes: 0 done, 2 Microsoft Word is not installed, 1 any other error (message on stderr).
# stdout: "OFFICE_PID <n>" once Word has started (the new WINWORD process), so the app can end it on timeout/cancel.
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
$m = [Type]::Missing
# Word's PDF Reflow prompt ("Word will now convert your PDF...") is turned off by the app (electron/office.js)
# through HKCU ...\Word\Options DisableConvertPdfWarning before this script runs, and restored after it ends,
# also when the app kills this script on timeout/cancel (a `finally` here would not run then).
function Get-OneLine([string]$s) { return ($s -replace '\s*[\r\n]+\s*', ' ').Trim() }
try {
  try { Unblock-File -LiteralPath $In } catch {} # the input is the app's own temp copy
  $before = @(Get-Process -Name 'WINWORD' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  try { $word = New-Object -ComObject Word.Application } catch { [Console]::Error.WriteLine('Microsoft Word is not installed'); exit 2 }
  $started = @(Get-Process -Name 'WINWORD' -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })
  if ($started.Count -eq 1) { [Console]::Out.WriteLine("OFFICE_PID $($started[0].Id)"); [Console]::Out.Flush() }
  $word.Visible = $false
  $word.DisplayAlerts = 0 # wdAlertsNone
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
}
