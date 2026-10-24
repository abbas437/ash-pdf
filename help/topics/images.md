---
id: images
title: Adding and editing images
section: Edit
order: 30
keywords: image, picture, png, jpeg, logo, move, resize, delete
---

# Adding and editing images

Two tools deal with pictures. **Image** places a new PNG or JPEG on a page. **Edit image** moves, resizes or deletes pictures that are already part of the page.

## Place an image

1. Choose **Image (PNG, JPEG)** on the toolbar, or press <kbd>I</kbd>. [Show me](#showme:tool:image)
2. Pick a file in the dialog. Only PNG and JPEG files work; the type is read from the file itself, not its name.
3. Click the page where the image should go. It is centred on your click and sized to 40% of the page width, then kept within the page.
4. The tool returns to **Select**, so you can drag the picture or resize it straight away.

The options bar offers:

| Option | Effect |
| --- | --- |
| Choose image… | Pick a different file |
| Opacity | 10% to 100% |
| Rotation | -180 to 180 degrees |

Hold <kbd>Shift</kbd> while dragging a corner to resize freely; otherwise the proportions are kept. The same options are under **Tools** as **Insert image…**.

> **Tip:** You can also paste an image from the clipboard. It is placed at the pointer and made no larger than half the page.

A placed image is an annotation. It can be moved and changed until you save.

## Edit an image already in the document

1. Choose **Edit image** or press <kbd>J</kbd>. [Show me](#showme:tool:image-edit)
2. Hover over a picture. A dashed blue outline shows it can be edited.
3. Click to select it. Eight handles appear.
4. Drag the picture to move it, or drag a handle to resize it. Hold <kbd>Shift</kbd> to keep the shape.
5. To remove it, click **Delete** in the options bar or press <kbd>Delete</kbd>.
6. Press <kbd>Esc</kbd> to deselect.

Each move, resize or delete is one undo step (see [undo and redo](#topic:undo-redo)).

## Limits

- Pictures inside a form object get a grey outline and cannot be edited. The pointer shows a "not allowed" cursor.
- Edit image changes the picture's position and size only, not its pixels.
- Other formats, such as GIF or WebP, are refused with a message.

> **Note:** Deleting a picture with **Edit image** removes it from the page content. If you only want to hide it permanently along with other content, see [redaction](#topic:redaction).
