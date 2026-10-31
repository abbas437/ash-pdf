---
id: insert-delete-pages
title: Insert and delete pages
section: Pages
order: 20
keywords: insert, blank page, insert from file, delete, remove pages, drop PDF
---

# Insert and delete pages

Open [the Pages menu](#showme:btn:pages) on the toolbar for these commands. They work on the pages selected in [the thumbnails](#topic:page-thumbnails), or on the current page if none is selected.

## Insert a blank page

1. Select a page in the thumbnails.
2. Choose Pages ▸ **Insert blank page**. The new page goes after the last selected page.

The thumbnail right-click menu also offers "Insert blank page before" and "Insert blank page after".

## Insert pages from files

Choose Pages ▸ **Insert from file…** (also on the Tools menu) to add pages from other files in one step.

1. Pick one or more files: PDF, pictures (PNG, JPEG, GIF, WebP, BMP, SVG), Word (`.docx`), Excel (`.xlsx`) or text (`.txt`, `.md`).
2. They are inserted after the last selected page (or the current page), in the order you picked them, as one step that **Undo** reverses.

Each picture becomes a page the size of the page before it (the first page when inserted at the start), turned to match the picture, with the picture centred inside 18 pt margins. Word, Excel and text files are converted the same way as [File ▸ Create PDF from Office](#topic:create-pdf-from-office) with the built-in engine.

> **Note:** Converting Word, Excel and text files needs the desktop app. PDFs and pictures work everywhere.

## Insert selected pages of another PDF

1. Choose Tools ▸ **Insert pages from PDF…**.
2. Click **Choose PDF…**, pick an open document, or drop a file on the dialog.
3. Complete the fields:

| Field | Meaning |
| --- | --- |
| Pages to insert | Leave empty for all pages, or enter ranges such as 1-3,5 |
| Insert after page | 0 inserts before page 1; the last page number appends at the end |

4. Click **Insert**. The new pages are selected afterwards.

## Drop files on the page view

Drag files over the page view. A line shows the position and the hint reads "Insert at page N · drop on the tab bar to open".

- **PDF, Word, Excel and text files** are inserted as pages at the line. Dropped on the tab bar instead, each opens as its own document.
- **Pictures** are placed *on* the page under the pointer (see [adding images](#topic:images)). Hold <kbd>Shift</kbd> while dropping to insert them as new pages at the line instead; the hint then reads "Insert as pages at page N (Shift)".
- Files of other types are skipped with the message "Not inserted: <name> (unsupported type)".

You can also drop files between thumbnails; there every file, pictures included, is inserted as pages.

## Delete pages

1. Select the pages to remove.
2. Press <kbd>Del</kbd> with a thumbnail focused, or choose Pages ▸ **Delete pages…**.
3. Confirm. You can undo it with Edit ▸ Undo.

> **Important:** A PDF must keep at least one page. If every page is selected, the program shows "Cannot delete every page" and nothing is removed.

> **Tip:** To replace pages rather than insert them, see [Replace pages](#topic:replace-pages). To add pictures as pages, see [Images to PDF](#topic:images-to-pdf).
