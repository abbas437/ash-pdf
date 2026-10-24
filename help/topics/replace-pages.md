---
id: replace-pages
title: Replace pages
section: Pages
order: 60
keywords: replace, swap, pages, source, another PDF, annotations, rescan
---

# Replace pages

Use this to swap pages in the current document for pages from another PDF, for example a corrected scan. The number of pages stays the same. To add pages instead, see [Insert and delete pages](#topic:insert-delete-pages). [Show me](#showme:btn:pages)

## Replace pages from another PDF

1. Choose **Tools ▸ Replace pages…**
2. Choose the source. Either click **Choose PDF…**, drop a PDF on the dialog, or pick one from **Or an open document…**
3. In **Source pages**, enter the pages to take from the source, such as 1-3,5. Leave it empty to use all of them.
4. In **Replace starting at page**, enter the first page to replace. It starts from the first selected thumbnail, or page 1.
5. Click **Replace**.

| Field | What it does |
| --- | --- |
| Source pages | Which pages of the source are used. Empty means all |
| Replace starting at page | First page replaced. The same number of pages is replaced from here on |

For example, three source pages starting at page 4 replace pages 4, 5 and 6.

> **Important:** Annotations on the replaced pages are removed with them. If there are any, a warning tells you how many and on which pages. Click **Replace** again to continue, or **Cancel** to keep them.

The dialog reports an error if the chosen pages would run past the end of the document, and shows the highest start page you can use.

> **Tip:** The replaced pages are selected afterwards, so you can check them straight away. If the result is wrong, use [Undo and redo](#topic:undo-redo).

Related: [Merge and split](#topic:merge-split), [Page thumbnails](#topic:page-thumbnails).
