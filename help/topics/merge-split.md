---
id: merge-split
title: Merge and split PDFs
section: Pages
order: 30
keywords: merge, combine, join, split, extract, page ranges, part
---

# Merge and split PDFs

## Merge PDFs into the current document

1. Choose File ▸ **Merge PDFs…** (or Pages ▸ Merge files…).
2. Add the sources:
   - **Add PDF files…** to pick one or more files;
   - choose an open document and click **Add open document**;
   - or drop PDF files on the dialog.
3. Order the list with the arrow buttons; use the cross to remove a file. Pages are added in the order listed.
4. Under Position, choose **Append at the end**, or **Insert after page** and enter a page number.
5. Click **Merge**.

> **Tip:** Merged pages are selected afterwards, and you can undo the merge. See [Undo and redo](#topic:undo-redo).

## Split a PDF into several files

1. Choose File ▸ **Split PDF…** or Pages ▸ **Extract / Split…**.
2. Under Split by, choose one of:

| Option | Meaning |
| --- | --- |
| Page ranges | One file per comma-separated range. Use ";" to put several ranges in one file |
| Every N pages | Cuts the document into parts of N pages each |

3. Click **Split** and choose where to save each part.

Parts are named `<name>-part-1.pdf`, `<name>-part-2.pdf` and so on.

### Page range examples

| Entry | Result |
| --- | --- |
| 1-3,5,8- | Three files: pages 1-3, page 5, and page 8 to the end |
| 1-2,4;5- | Two files: pages 1, 2 and 4 together, then page 5 to the end |

> **Note:** The original document is not changed by a split.

## Extract selected pages only

To save just some pages as one new PDF, select them in [the thumbnails](#topic:page-thumbnails), right-click and choose **Extract pages…**. The file is named after the document and the page numbers.

Merging works on whole pages. To insert only some pages of another file, see [Insert and delete pages](#topic:insert-delete-pages).
