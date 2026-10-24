---
id: export-word-excel-image
title: Export to Word, Excel or an image
section: Convert and optimise
order: 10
keywords: export, word, docx, excel, xlsx, image, png, jpeg, jpg, convert, resolution, dpi
---

# Export to Word, Excel or an image

Three commands on the **File** menu turn the open PDF into another format. [Show me the File menu](#showme:menu:File).

## Export to Word

1. Choose **File ▸ Export to Word…**.
2. Pick an **Engine**:
   - **ASH (built-in)** is the default. It rebuilds paragraphs, headings, tables and images from the PDF and does not need Microsoft Office.
   - **Microsoft Word (better layout, needs Word)** appears only on Windows with Word installed. Word does the conversion and may take several minutes for a long report; a **Converting** window with a Cancel button is shown meanwhile.
3. Click **Export…** and choose where to save the `.docx` file.

Annotations are included in both engines.

> **Note:** A scanned PDF has no text to rebuild. Run [text recognition](#topic:ocr) first.

## Export to Excel

1. Choose **File ▸ Export to Excel…**.
2. In **Pages**, leave the box empty for all pages, or type a range such as `1-3, 7`.
3. Tick or clear **Include images** (on by default).
4. Click **Export…** and save the `.xlsx` file.

Each page becomes one worksheet named "Page N". Text is placed in rows and columns by its position on the page, and plain numbers are stored as numbers.

> **Tip:** This works best on table-like pages. Pages of running text give an untidy sheet.

## Export to image

1. Choose **File ▸ Export to image…**.
2. Set the options:

| Option | Choices |
| --- | --- |
| Pages | Empty or `All`, `current`, or a range such as `1-3, 7`. The current page is filled in by default. |
| Format | PNG (default) or JPEG |
| Resolution | 72, 150 (default) or 300 dpi |
| JPEG quality (%) | 10 to 100, default 90; only used for JPEG |
| Include annotations | Yes (default) or No |

3. Click **Export…**. One page is saved as a single file. Several pages are saved as one file each in a folder you choose, with a progress window you can cancel.

> **Important:** At most 2000 pages can be exported at once. A very large page at 300 dpi may fail with "The page is too large to render at this resolution"; choose a lower resolution.

See also [Save and print](#topic:save-and-print) and [Troubleshooting](#topic:troubleshooting).
