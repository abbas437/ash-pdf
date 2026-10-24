---
id: header-footer-page-numbers
title: Add headers, footers and page numbers
section: Document marks
order: 10
keywords: header, footer, page number, numbering, date, file name, roman numerals, margins
---

# Add headers, footers and page numbers

Use **Document ▸ Header & Footer…** for text at the top or bottom of each page, or **Document ▸ Page Numbers…** for a quick page number in one position. [Show me the Document menu](#showme:menu:Document).

## Add a header or footer

1. Open **Document ▸ Header & Footer…**.
2. Type text into any of the six boxes: Header left, centre and right, and Footer left, centre and right. At least one box must contain text.
3. Set the other options (table below). The preview shows the current page and updates as you type.
4. Choose **Apply**.

Insert these tokens in any box:

| Token | Becomes |
| --- | --- |
| `<<page>>` | The page number |
| `<<pages>>` | The total number of pages |
| `<<date>>` | Today's date (YYYY-MM-DD) |
| `<<date:DD/MM/YYYY>>` | Today's date in your own format, using YYYY, YY, MMM, MM, M, DD and D |
| `<<file>>` | The file name |

## Add page numbers

1. Open **Document ▸ Page Numbers…**.
2. Choose a **Position** (header or footer; left, centre or right) and a **Format**, such as "Page 1 of 9" or "- 1 -".
3. Choose **Apply**.

## Options

| Option | Notes |
| --- | --- |
| Start number | The number printed on the first selected page (default 1) |
| Number format / Numbers | 1, 2, 3; i, ii, iii; I, II, III; a, b, c; or A, B, C |
| Font, Size, Colour | Helvetica, Times or Courier; 4 to 200 pt; any colour |
| Margin top, bottom, left, right | Header & Footer only, in points (defaults 36 top and bottom, 54 left and right) |
| Pages | A range such as `1-3,5`; leave empty for all pages |
| Apply to | All, Odd pages or Even pages |

> **Note:** Only Latin letters, digits and common symbols are supported. Arabic and other scripts are refused with a message.

> **Tip:** If the document already has a header or footer, the dialog offers **Replace the existing header & footer**. Untick it to add the new text on top instead. Page Numbers… shares the same mark type, so it replaces headers and footers too.

## Change or remove them

The mark is written into the page content, so it cannot be edited in place. To change it, open the dialog again and apply with Replace ticked. To take it off, choose **Document ▸ Remove header & footer**. That item is enabled only when the document has such a mark. The Document menu items are unavailable for encrypted (read-only) documents.

Each apply or remove is a single step you can reverse; see [Undo and redo](#topic:undo-redo). Save the file afterwards ([Save and print](#topic:save-and-print)).
