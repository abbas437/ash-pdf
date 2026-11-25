---
id: watermark-background
title: Add a watermark or background
section: Document marks
order: 20
keywords: watermark, remove watermark, acrobat watermark, background, confidential, draft, stamp, opacity, rotation, tile, image, colour
---

# Add a watermark or background

A watermark is text or an image placed on each page, such as CONFIDENTIAL. A background fills the page behind the content with a colour or image. [Show me the Document menu](#showme:menu:Document).

## Add a watermark

1. Open **Document ▸ Watermark…**.
2. Under **Watermark**, choose **Text** or **Image (PNG or JPEG)**. For text, type it in; for an image, choose **Choose image…**.
3. Adjust the options below and check the preview of the current page.
4. Choose **Apply**.

| Option | Notes |
| --- | --- |
| Font, Size, Colour | Text only; default 48 pt, red |
| Position | Centre, Tiled across the page, or one of eight edge and corner positions |
| Layer | Over the page content, or Behind the page content |
| Opacity (%) | 5 to 100 (default 30) |
| Rotation (°) | -180 to 180 (default 45) |
| Width (% of page) | Leave empty for Auto |
| Pages / Apply to | A range such as `1-3,5`, and All, Odd or Even pages |

## Add a background

1. Open **Document ▸ Background…**.
2. Choose **Colour** (pick the colour) or **Image (PNG or JPEG)**.
3. Set **Opacity (%)** from 5 to 100, and optionally a page range.
4. Choose **Apply**. The background is always drawn behind the page content.

> **Note:** Watermark text must use Latin letters, digits and common symbols. For other scripts, use an image.

> **Tip:** If the document already has one, tick **Replace the existing watermark** (or background) to swap it; untick it to stack another on top.

## Change or remove

Marks are stored as separate layers in the page content, not as objects you can select, so you cannot edit one in place. Open the dialog again and Replace it.

To remove a background, choose **Document ▸ Remove background**. It is enabled only when the document contains a background added with PDF Studio.

To remove a watermark, choose **Document ▸ Remove watermark…**. PDF Studio looks for three kinds and lists what it finds, each with a tick box (all ticked at first):

- **PDF Studio watermark**: one added with **Watermark…**, with the number of pages that have it.
- **Watermark from another program**: one marked as a watermark by the program that made it, with the number of pages.
- **Watermark annotations**: watermarks stored as annotations, with how many there are.

Untick any you want to keep and choose **Remove**. Only remove watermarks you are entitled to remove, such as your own or your organisation's DRAFT or FOR REVIEW marks. A watermark that is part of a scanned image isn't found. One drawn as ordinary page content isn't found either, but you can pick it on the page (below). If the document is signed, removing a watermark changes the page content, so the signatures become invalid.

### Watermarks drawn as ordinary content

Some programs draw a watermark as ordinary text, an image or shapes, without marking it as a watermark. To remove one, choose **Pick it on the page…** in the **Remove watermark** dialog (it is also offered when no marked watermark is found):

1. Go to a page that shows the watermark.
2. Click the watermark. The part you clicked is outlined. If the watermark is made of several parts (for example two words), Shift+click each other part to add it. Clicking empty space clears your choice.
3. Press Enter. PDF Studio looks for the same objects in the same place on every page and tells you how many pages it found them on and which pages they are, or that it found them only on this page. Choose **Show next match** to go to each of those pages in turn, with the matched objects outlined.
4. Choose **Remove**, or **Cancel** to keep them.

Text whose characters the document doesn't identify can't be picked ("This text can't be matched reliably"), nor can one object that covers most of the page. Only objects that repeat in the same place are removed: the same text, image or shape elsewhere on a page, and the rest of the page content, are kept. Press Esc at any point to stop without changing the document. Only remove watermarks you are entitled to remove, such as your own or your organisation's DRAFT or FOR REVIEW marks.

Removing a marked watermark removes only the watermark. Picking removes only the matched objects, but PDF Studio rewrites the content of those pages to do so, so check the result before you save. After you save a document from which a watermark was removed, undo history for page changes starts again from the saved document. Encrypted (read-only) documents cannot be marked.

Every apply and remove can be reversed in one step ([Undo and redo](#topic:undo-redo)). Remember to save ([Save and print](#topic:save-and-print)).
