---
id: create-pdf-from-office
title: Create a PDF from an Office file
section: Convert and optimise
order: 20
keywords: office, word, excel, powerpoint, docx, xlsx, pptx, convert, create pdf, microsoft office
---

# Create a PDF from an Office file

**File ▸ Create PDF from Office…** converts a Word, Excel or PowerPoint file to PDF. [Show me the File menu](#showme:menu:File).

## Steps

1. Choose **File ▸ Create PDF from Office…**.
2. Pick an **Engine**:
   - **ASH (built-in)** is the default and needs no Microsoft Office.
   - **Microsoft Office (Word, Excel, PowerPoint)** appears only on Windows when Office is available.
3. Click **Choose file…** and select the file.
4. Built-in engine: the PDF opens in a new, unsaved tab named after the file. Use **File ▸ Save** to keep it.
5. Microsoft Office engine: you are asked where to save the PDF, then a **Converting** window appears. Click **Cancel** to stop; any partial output file is removed. The finished PDF opens in a tab.

## What each engine converts

| Engine | File types | Notes |
| --- | --- | --- |
| ASH (built-in) | `.docx`, `.xlsx` | Word: headings, paragraphs, lists, tables and images. Excel: every sheet as a table, one sheet per page. A workbook with a sheet wider than 8 columns prints landscape. Pages are A4 with 15 mm margins. |
| Microsoft Office | `.doc`, `.docx`, `.rtf`, `.xls`, `.xlsx`, `.ppt`, `.pptx` | Uses the installed Word, Excel or PowerPoint, so the layout matches what Office prints. |

> **Note:** The built-in engine is a simplified rendering. Page layout, fonts, headers, footers and charts may differ from the original. Use the Office engine when layout matters.

## Limits and errors

- The Office engine allows 5 minutes per file. After that you see "Microsoft Office did not finish within 5 min. Try again; for a long document, close other Office windows first."
- If the application is missing, the message reads "Microsoft Word is not installed" (or Excel, PowerPoint).
- If PowerPoint is stopped part-way it may keep running; the message says so.
- A failed attempt shows **Could not create the PDF** with the reason.

> **Important:** The Microsoft Office engine is Windows only and needs a desktop copy of Office. Elsewhere the message is "Requires Microsoft Office on Windows".

To go the other way, see [Export to Word, Excel or an image](#topic:export-word-excel-image). For pictures, see [Images to PDF](#topic:images-to-pdf).
