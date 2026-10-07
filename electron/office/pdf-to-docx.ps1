# ASH PDF Studio: PDF -> Word document through Microsoft Word (PDF Reflow).
# Run: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pdf-to-docx.ps1 <in.pdf> <out.docx>
# Exit codes: 0 done, 2 Microsoft Word is not installed, 1 any other error (message on stderr).
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  try { $word = New-Object -ComObject Word.Application } catch { [Console]::Error.WriteLine('Microsoft Word is not installed'); exit 2 }
  $word.Visible = $false
  $word.DisplayAlerts = 0 # wdAlertsNone
  # Documents.Open(FileName, ConfirmConversions:=false, ReadOnly:=true)
  $doc = $word.Documents.Open($In, $false, $true)
  $doc.SaveAs2($Out, 16) # wdFormatDocumentDefault (.docx)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($doc) { try { $doc.Close($false) | Out-Null } catch {} }
  if ($word) { try { $word.Quit() | Out-Null } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
}
