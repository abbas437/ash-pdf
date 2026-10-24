---
id: bates-numbering
title: Add Bates numbers
section: Document marks
order: 30
keywords: bates, bates numbering, legal, sequential, identifier, prefix, suffix, document control
---

# Add Bates numbers

Bates numbers give every page a unique, sequential identifier such as `ABC-000001`, commonly used for legal and document-control work. [Show me the Document menu](#showme:menu:Document).

## Add Bates numbers

1. Open **Document ▸ Bates Numbering…**.
2. Fill in the fields (table below). The preview shows the current page.
3. Choose **Apply**. A message reports the last number used.

| Field | Notes |
| --- | --- |
| Prefix | Text before the number, for example `ABC-` |
| Suffix | Text after the number |
| Start number | Number on the first selected page (default 1) |
| Digits | Zero-padded length, 1 to 12 (default 6) |
| Position | Header or footer; left, centre or right (default Footer, right) |
| Font, Size, Colour | Helvetica, Times or Courier; default 10 pt, black |
| Pages / Apply to | A range such as `1-3,5`, and All, Odd or Even pages |

With prefix `CASE-`, start 101 and 6 digits, the first page reads `CASE-000101`.

> **Note:** Numbering follows the pages you select. If you choose a page range, only those pages are numbered, in order.

> **Tip:** To continue numbering from a previous file, set **Start number** to the next number after the earlier "last number" message.

## Change or remove

Bates numbers are written into the page content and cannot be edited in place. If the document already has them, the dialog offers **Replace the existing Bates numbers**; keep it ticked to renumber.

To take them off, choose **Document ▸ Remove Bates numbers**. This is enabled only when the document contains Bates numbers. Encrypted (read-only) documents cannot be numbered.

Each apply or remove is one step you can reverse ([Undo and redo](#topic:undo-redo)). Save afterwards ([Save and print](#topic:save-and-print)). For other page text see [Headers, footers and page numbers](#topic:header-footer-page-numbers).
