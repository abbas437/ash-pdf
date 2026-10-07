# ASH PDF Studio: Word / Excel / PowerPoint file -> PDF through Microsoft Office.
# Run: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File office-to-pdf.ps1 <word|excel|powerpoint> <in> <out.pdf>
# Exit codes: 0 done, 2 the Office application is not installed, 1 any other error (message on stderr).
param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$progIds = @{ word = 'Word.Application'; excel = 'Excel.Application'; powerpoint = 'PowerPoint.Application' }
$names = @{ word = 'Microsoft Word'; excel = 'Microsoft Excel'; powerpoint = 'Microsoft PowerPoint' }
if (-not $progIds.ContainsKey($Kind)) { [Console]::Error.WriteLine("Unknown kind: $Kind"); exit 1 }
$appObj = $null
$doc = $null
try {
  try { $appObj = New-Object -ComObject $progIds[$Kind] } catch { [Console]::Error.WriteLine("$($names[$Kind]) is not installed"); exit 2 }
  switch ($Kind) {
    'word' {
      $appObj.Visible = $false
      $appObj.DisplayAlerts = 0
      $doc = $appObj.Documents.Open($In, $false, $true)
      $doc.ExportAsFixedFormat($Out, 17) # wdExportFormatPDF
    }
    'excel' {
      $appObj.Visible = $false
      $appObj.DisplayAlerts = $false
      $doc = $appObj.Workbooks.Open($In, 0, $true) # UpdateLinks:=0, ReadOnly:=true
      $doc.ExportAsFixedFormat(0, $Out) # xlTypePDF, the whole workbook (all sheets)
    }
    'powerpoint' {
      $appObj.DisplayAlerts = 1 # ppAlertsNone; PowerPoint refuses Visible = false, the window stays hidden through WithWindow
      $doc = $appObj.Presentations.Open($In, -1, 0, 0) # ReadOnly, Untitled:=false, WithWindow:=false
      $doc.SaveAs($Out, 32) # ppSaveAsPDF
    }
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($doc) { try { if ($Kind -eq 'excel') { $doc.Close($false) } elseif ($Kind -eq 'word') { $doc.Close($false) } else { $doc.Close() } } catch {} }
  if ($appObj) { try { $appObj.Quit() | Out-Null } catch {}; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($appObj) }
}
