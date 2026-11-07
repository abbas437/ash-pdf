---
id: compare-revisions
title: Compare revisions
section: Getting started
order: 62
keywords: compare, revision, rev.00, rev.01, differences, changes, overlay, diff, red green, resubmission, side by side, csv
---

# Compare revisions

**Compare revisions** shows what changed between two revisions of a document, such as a contractor's Rev.00 and Rev.01 of a drawing. Each page of the newer revision is compared with the same page of the older one, and the result opens as a **new PDF** in its own tab, with every change marked.

## Run a compare

1. Open the two revisions, or at least one of them. [Show me the Tools menu](#showme:menu:Tools)
2. Choose **Tools ▸ Compare revisions…**.
3. Choose the **Older revision** and the **Newer revision**. The lists show your open documents; choose **Browse…** to open another file. When the names carry a revision, such as Rev.00 and Rev.01, R0 and R1, or A and B, the older one is chosen for you.
4. Optionally set:
   - **Pages**: leave it empty for all pages, or type pages such as `1-5` or `2, 4, 7`.
   - **Quality**: 100, 150 (the default) or 200 dpi. Higher quality finds finer changes but takes longer and makes a larger result.
   - **Align shifted pages automatically**: when a whole sheet has moved a little (for example, after it was re-plotted), the pages are lined up before they are compared, so the shift itself is not shown as a change.
   - **List text changes**: also lists the words that were added and removed.
5. Click **Compare**. A progress box shows the page being compared; click **Cancel** to stop. Nothing is opened when you cancel.

The comparison is of the **ink** on the page: a line or word that only changed colour is not counted as a change.

## Read the result

On each page of the result:

- ink that is the same in both revisions is **grey**;
- ink that was **removed** (only in the older revision) is **red**;
- ink that was **added** (only in the newer revision) is **green**.

Each changed area has a **dashed rectangle** round it with a short note, such as "Change 1: added" or "Change 2: added and removed", plus the words that changed inside it. Point at a rectangle, or open it, to read its note. A legend in the corner names the two revisions and the date of the compare, and the **Bookmarks** list each page with changes.

## The Differences panel

The **Differences** panel opens in the sidebar with the result. It lists each page with changes, then its areas (**Change 1**, **Change 2**, …) and its text changes (**+** added, **−** removed).

- Click an item to go to it. The change is outlined for a moment.
- **Side by side** shows the older and the newer revision in a split view with **Scroll and zoom together** on, at that page. Both revisions must still be open. See [Split view](#topic:split-view).
- **Copy list** copies the list as plain text, for pasting into an email or a comment sheet.
- **Export CSV** saves the list as a spreadsheet file (Page, Kind, Item, Text) that opens in Excel.

## Save, print or send the result

The result is an ordinary PDF. Save, print or send it like any other document (see [Save and print](#topic:save-and-print)). It is a **new file**: the two revisions you compared are not changed.

## Limits

- Pages are compared **in order**: page 1 with page 1, page 2 with page 2, and so on. If a sheet was inserted or deleted, the pages after it are compared with the wrong partner; use **Pages** to compare a part of the set.
- Pages beyond the end of the shorter revision are shown as **added** (only in the newer revision) or **removed** (only in the older one).
- The pages are compared as pictures at the chosen quality. Very fine changes, such as a small digit in a dimension, may need **200 dpi**.
- Text changes come from the text stored in the PDF. A scanned page has none unless it has been through [Recognise text (OCR)](#topic:ocr).
- When you reopen a saved compare PDF, the Differences panel lists its marked areas. The text list and **Side by side** work only in the session that made the compare; run it again to get them back.
