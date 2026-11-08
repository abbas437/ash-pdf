---
id: measure
title: Measure distances and areas on drawings
section: Comment
order: 65
keywords: measure, scale, dimension, distance, area, perimeter, calibrate, drawing scale, 1:50, imperial, feet and inches, takeoff
---

# Measure distances and areas on drawings

Measure is for checking dimensions on PDF drawings, such as shop drawings and site plans. You set the
scale the sheet was drawn at, and measurements on the page show real lengths and areas, for example
`2500 mm` or `12'-6"`.

## Set the scale

Choose **Tools ▸ Set measure scale…**. The dialog shows the scale of the current page and where it
comes from: **From the PDF**, **Calibrated**, the preset (such as **1:50**), or **Default** when the page
has no scale of its own yet.

- **Drawing scale**: pick a preset from 1:1 to 1:1000, or **Custom 1:n…** and type a scale such as
  `1:30`. Choose the units: mm, cm or m.
- **Imperial**: pick an architectural or engineering scale, from 1/8" = 1'-0" to 1" = 50'. Show the
  results as feet and inches (`12'-6 1/2"`) or as decimal feet.
- **Calibrate…**: use this when the sheet has no stated scale, or was printed or scanned at another
  size. The dialog closes; click the two ends of a dimension you know, such as a dimensioned wall or a
  scale bar. Hold **Shift** to keep the line horizontal, vertical or at 45°. Press **Esc** to cancel. The
  dialog comes back with the length you picked: type its real length and choose the units. A line
  shorter than 5 points is refused; click two points further apart.
- **Precision**: the number of decimals (0 to 3), or for feet and inches the smallest fraction shown:
  1/16", 1/8", 1/4" or 1/2".
- **Apply to**: **This page**, or **All pages** of the document.

Click **OK**. Changing the scale is one step you can undo with **Ctrl+Z**. The scale you set last is
also the starting scale of documents that have none.

> [!NOTE]
> Measurements keep the scale they were made with. Changing the page scale later applies to new
> measurements only, so earlier ones still show their original values.

## Measure

Choose **Measure** in the toolbar, after Shapes, then pick **Distance**, **Perimeter** or **Area** in
its options bar. The options bar also shows the page scale; click it to open the scale dialog.

- **Distance**: click the two ends, or press, drag and release.
- **Perimeter** and **Area**: click each corner in turn. The running value follows the pointer.
  Double-click or press **Enter** to finish, **Backspace** removes the last point, and **Esc** cancels.
  Area closes the shape for you and needs at least three points.
- Hold **Shift** to keep a segment horizontal, vertical or at 45°.
- **Snapping**: near the end of a line drawn in the PDF, a small square appears and the point snaps
  exactly to that end. Hold **Alt** to place a point freely.

Each tool remembers its own colour and line width (distance red, perimeter blue, area green to
start). A measurement is a markup like any other: select it to move it, drag a corner to change it
(the value updates), add a comment to label it, or delete it. **Ctrl+Z** undoes each step.

## The Measurements list

Open **Measurements** in the sidebar to see every measurement in the document by page, with its
value, scale and comment, and the totals for each kind. Click a row to go to that measurement.
**Export CSV…** saves the list for Excel: page, kind, value at full precision, unit, scale and comment.

## The scale is saved in the PDF

The page scale is saved in the PDF as a standard measurement viewport, so other PDF programs can use
it. Scales set in Adobe Acrobat or Bluebeam Revu are read when you open the file, and the dialog then
shows **From the PDF**.

> [!IMPORTANT]
> A digitally signed PDF keeps its signature when you save comments and markups: they are added as
> an update after the signed revision. A page scale changes the page itself, so in a signed PDF it is
> saved only when the whole file is saved again (for example when you choose to overwrite the signed
> original), which ends the signature's validity.
