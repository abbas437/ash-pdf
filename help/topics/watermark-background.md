---
id: watermark-background
title: Add a watermark or background
section: Document marks
order: 20
keywords: watermark, background, confidential, draft, stamp, opacity, rotation, tile, image, colour
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

To remove one, choose **Document ▸ Remove watermark** or **Document ▸ Remove background**. Each is enabled only when the document contains that mark. Removing leaves your other content untouched. Encrypted (read-only) documents cannot be marked.

Every apply and remove can be reversed in one step ([Undo and redo](#topic:undo-redo)). Remember to save ([Save and print](#topic:save-and-print)).
