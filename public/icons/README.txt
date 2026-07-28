BIG SUN WALL: CUSTOM ICONS
==========================

Drop PNG files in this folder and they replace the built in artwork.
Anything missing falls back on its own, so you can add them one at a
time and refresh to see each one land. Nothing breaks if you never add
any at all.


THE SPEC
--------
Size:        32 x 32 pixels (16 x 16 also works)
Format:      PNG
Background:  TRANSPARENT. This one is required. The button behind the
             icon changes colour, so a filled background will look like
             a sticker sitting on the button.
Colours:     Anything. The phone's toolbox is always classic grey. The
             wall's toolbox follows whatever colour scheme is running,
             so avoid pure black outlines with nothing else going on or
             they can get lost on a dark scheme.
Anti-alias:  Do not. Hard pixel edges only, no soft or feathered edges.

             This is the single most common thing that makes finished
             icons look wrong. To check, open your PNG and zoom right
             in on a diagonal edge. If the edge is one hard step from
             colour to transparent, it is correct. If there is a halo
             of half transparent pixels softening the step, the editor
             anti-aliased it. Turn that off and redraw the edge. In
             Piskel the pen is hard edged by default, but the line and
             shape tools are where softening usually creeps in.


THE PHONE APP: FIVE FILES
-------------------------
These are the ones worth doing first, since this is the screen people
actually hold.

    airbrush.png      the spray can
    brush.png         the paintbrush
    eraser.png        the eraser
    undo.png          undo arrow
    clear.png         clear the canvas


WINDOW AND TASKBAR: TWO FILES
-----------------------------
These are used by both the phone app and the projector wall, so drawing
them once covers everything.

    app.png           the icon in the window title bar, and again in the
                      taskbar button along the bottom
    start.png         the logo on the Start button

app.png shows up small, around 16px in the title bar. Keep it bold and
simple. A few big shapes read far better at that size than fine detail,
which just turns to noise.


THE WALL'S DECORATIVE TOOLBOX: SIXTEEN FILES
--------------------------------------------
The projector wall shows a full Paint toolbox down the left side. These
are optional. It is seen from across a car park and the built in ones
look fine at that distance.

Custom icons here are ALL OR NOTHING. Until all sixteen exist, the wall
keeps its own matching set. That is on purpose. Three of your five phone
icons are shared with the wall, and loading only those would leave its
toolbox half your style and half the built in one. So there is no half
finished state. Add all sixteen and the wall switches over, or add none
and it stays consistent.

    freeform.png      free form select
    select.png        rectangular select
    eraser.png        (shared with the phone)
    fill.png          paint bucket
    picker.png        colour picker
    magnify.png       magnifier
    pencil.png        pencil
    brush.png         (shared with the phone)
    airbrush.png      (shared with the phone)
    text.png          the A
    line.png          straight line
    curve.png         curve
    rect.png          rectangle
    polygon.png       polygon
    ellipse.png       ellipse
    roundrect.png     rounded rectangle


WHERE TO DRAW THEM
------------------
Any pixel editor that exports transparent PNG at an exact size:

  Piskel          piskelapp.com              free, browser, made for this
  Lospec editor   lospec.com/pixel-editor    free, browser
  GIMP            gimp.org                   free, desktop
  Aseprite                                   paid, the nicest of them

Set the canvas to 32 x 32, turn off anti-aliasing, use the pencil at
1px, and export as PNG with transparency.

If you want to trace the originals, real Windows 95 Paint icons are easy
to find as reference. Search for "Windows 95 Paint toolbar icons".


AFTER YOU ADD THEM
------------------
Upload the icons folder to GitHub the same way as everything else,
inside public/ so the path ends up as:

    public/icons/airbrush.png

Render redeploys on its own. Then hard refresh the page with
Ctrl + Shift + R so the browser fetches the new files instead of the
cached copies. If your icons do not seem to have changed, this is
almost always why.
