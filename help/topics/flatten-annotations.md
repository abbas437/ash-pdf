---
id: flatten-annotations
title: Flatten annotations
section: Comment
order: 80
keywords: flatten, burn in, make permanent, annotations, markup, lock, share, print
---

# Flatten annotations

Flattening turns saved annotations into part of the page content. The marks still look the same, but they can no longer be edited, moved or deleted. Use it before sharing a final copy when you do not want recipients to change or remove your markup.

## Flatten a document

1. Save your markup first, because only saved annotations are flattened.
2. Choose **Document ▸ Flatten annotations…**.
3. Under **Apply to**, choose **All pages** or **Current page**.
4. Choose **Flatten**.

If the document has unsaved changes, the dialog also offers **Save first**, which saves and then flattens.

## What is and is not flattened

| Annotation | Result |
|---|---|
| Already saved in the file | Flattened |
| Drawn since the file was opened | Not affected; stays editable |
| Edited or deleted since the last save | Skipped; the dialog tells you how many. Choose **Save first** to flatten what you see |

If there is nothing to flatten you see "No saved annotations to flatten" (or "...on this page").

## Undo and irreversibility

Flattening is one undo step while the document is open, and undo restores the annotations (see [Undo and redo](#topic:undo-redo)). Once you save and close the file, the change cannot be reversed. Keep an unflattened copy of the file before you flatten and save.

> **Important:** A flattened mark can still be seen and copied by anyone. Flattening does not hide anything; to remove content permanently, use [Redaction](#topic:redaction).

> **Note:** Read-only documents cannot be flattened. Flattened marks are no longer editable in the [Comments panel](#topic:comments-panel).

## Author name

Annotations you save carry your author name. See [Author name](#topic:author-name) to change it.
