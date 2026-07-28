BIG SUN WALL - CUSTOM TOOLBOX ICONS
===================================

Drop PNG files in this folder and they replace the built-in drawn icons.
Anything missing falls back automatically, so you can add them one at a
time and refresh to see each one land. Nothing breaks if you never add any.


THE SPEC
--------
Size:        16 x 16 pixels  (32 x 32 also works if you want more detail)
Format:      PNG
Background:  TRANSPARENT - yes, required. The button behind the icon
             changes colour, so a filled background will look like a
             sticker sitting on the button.
Colours:     Draw as if on the classic grey button face (#C0C0C0).
             Black outlines are correct.

             The phone app is always classic grey, so that's simply what
             your icons sit on. The projector wall runs a dark scheme
             (Eggplant), but its toolbox flips back to grey automatically
             the moment a complete custom set loads - so you never need a
             second dark version of anything. Draw once, for grey.
Anti-alias:  Don't. Hard pixel edges only, no soft or feathered edges.
             The icons get scaled up on screen, and soft edges turn to mush.

             This is the single most common thing that makes finished
             icons look wrong. Check for it: open your PNG and zoom
             right in on a diagonal edge. If the edge is one hard step
             from colour to transparent, it's correct. If there's a
             halo of half-transparent pixels softening the step, the
             editor anti-aliased it - turn that off and redraw the edge.
             In Piskel the pen is hard-edged by default; the shape and
             line tools are where softening usually creeps in.


FILE NAMES
----------
The phone app uses these five. These are the ones worth doing first,
since this is the screen people actually hold:

    airbrush.png      the spray can
    brush.png         the paintbrush
    eraser.png        the eraser
    undo.png          undo arrow
    clear.png         clear the canvas (currently a bin)

The projector wall shows a full decorative Paint toolbox. These are
OPTIONAL. It's seen from across a car park and the built-in ones look
fine at that distance.

Important: the wall uses custom icons ALL OR NOTHING. Until all sixteen
below exist, it keeps its own matching set. That's deliberate - three of
your five phone icons (airbrush, brush, eraser) are shared with the wall,
and loading only those would leave its toolbox half your style and half
mine. So there's no half-finished state: add all sixteen and the wall
switches over, or add none and it stays consistent.

    freeform.png      free-form select
    select.png        rectangular select
    fill.png          paint bucket
    picker.png        colour picker / eyedropper
    magnify.png       magnifier
    pencil.png        pencil
    text.png          text tool (the A)
    line.png          straight line
    curve.png         curve
    rect.png          rectangle
    polygon.png       polygon
    ellipse.png       ellipse
    roundrect.png     rounded rectangle

(eraser.png, brush.png and airbrush.png are shared - the wall uses the
same files as the phone, so you only draw those once.)


WHERE TO DRAW THEM
------------------
Any pixel editor that exports transparent PNG at an exact size:

  - Piskel          piskelapp.com        free, browser, made for this
  - Lospec editor   lospec.com/pixel-editor    free, browser
  - GIMP            gimp.org             free, desktop
  - Aseprite                             paid, the nicest of the lot

Set the canvas to 16 x 16, turn OFF anti-aliasing, use the pencil tool
at 1px, and export as PNG with transparency.

If you want to trace the originals, real Windows 95 Paint icons are
easy to find as reference - search for "Windows 95 Paint toolbar icons".
Matching them by eye at 16 x 16 gets you very close.


AFTER YOU ADD THEM
------------------
Upload the icons folder to GitHub the same way as the rest, inside
public/ so the path is:  public/icons/airbrush.png

Render redeploys on its own. Then hard-refresh the page (Ctrl+Shift+R)
so the browser fetches the new files instead of its cached copies.
