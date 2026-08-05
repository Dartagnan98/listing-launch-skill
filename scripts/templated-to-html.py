#!/usr/bin/env python3
"""
Templated -> HTML converter.

Reads <name>.meta.json + <name>.layers.json from templates/source/,
produces templates/html/<name>.html that matches the Templated render pixel-for-pixel.

Fields filled at render time are left as {{canonical_name}} placeholders (see semantic-map.json).
Static/decorative layers keep their sample content baked in (logos, icons, shapes, contact info).

Fonts: all Google Fonts used by the templates are loaded from fonts.googleapis.com.

Usage:
  python3 scripts/templated-to-html.py                 # convert all 9
  python3 scripts/templated-to-html.py coming-soon-A   # convert one
"""
import json, os, sys, glob, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
SRC = SKILL / "templates" / "source"
OUT = SKILL / "templates" / "html"
OUT.mkdir(parents=True, exist_ok=True)

SEMANTIC = json.loads((SKILL / "templates" / "semantic-map.json").read_text())

# invert: raw layer name -> canonical field
RAW_TO_CANONICAL = {}
for canonical, raws in SEMANTIC.items():
    if canonical.startswith("_"):
        continue
    for raw in raws:
        RAW_TO_CANONICAL[raw] = canonical

STATIC = set(SEMANTIC.get("_static_decorative", []))


def css_color(c):
    """Pass-through rgba/rgb strings are valid CSS."""
    if not c:
        return "transparent"
    return c


def px(v):
    if v is None:
        return "0"
    if isinstance(v, str) and v.endswith("px"):
        return v
    return f"{v}px"


def text_align(h):
    return {"left": "left", "center": "center", "right": "right"}.get(h, "left")


def flex_align(v):
    return {"top": "flex-start", "center": "center", "bottom": "flex-end"}.get(v, "flex-start")


def strip_html(s):
    if not s:
        return ""
    # strip Templated span wrappers like <span style="...">text</span>
    return re.sub(r"<[^>]+>", "", s)


# Templated font family names often carry a style/weight suffix, e.g.
# "Lora-Italic", "Aleo-BoldItalic", "Montserrat-ExtraLight". Google Fonts
# rejects those as family names, so we split them into (family, weight, style).
WEIGHT_WORDS = {
    "thin": 100, "extralight": 200, "ultralight": 200, "light": 300,
    "regular": 400, "normal": 400, "medium": 500, "semibold": 600,
    "demibold": 600, "bold": 700, "extrabold": 800, "black": 900,
}


def parse_font(raw):
    """Return (family, weight_int, italic_bool). None-safe."""
    if not raw:
        return ("sans-serif", 400, False)
    if "-" not in raw:
        return (raw, 400, False)
    family, _, suffix = raw.partition("-")
    italic = "italic" in suffix.lower()
    # strip 'Italic' off the suffix to leave weight words
    weight_token = re.sub(r"italic", "", suffix, flags=re.I).strip()
    weight = WEIGHT_WORDS.get(weight_token.lower(), 400) if weight_token else 400
    return (family, weight, italic)


def render_layer(l, canonical_for_layer):
    raw = l["layer"]
    typ = l["type"]
    x, y, w, h = l.get("x", 0), l.get("y", 0), l.get("width", 0), l.get("height", 0)
    rotation = l.get("rotation")
    opacity = l.get("opacity")

    base_style = (
        f"position:absolute;left:{px(x)};top:{px(y)};"
        f"width:{px(w)};height:{px(h)};"
    )
    if rotation:
        base_style += f"transform:rotate({rotation}deg);transform-origin:center center;"
    if opacity is not None:
        base_style += f"opacity:{opacity};"
    if l.get("border_width"):
        base_style += (
            f"border:{px(l['border_width'])} {l.get('border_style') or 'solid'} "
            f"{css_color(l.get('border_color'))};"
        )
    if l.get("border_radius"):
        base_style += f"border-radius:{px(l['border_radius'])};"

    data_attrs = f' data-layer="{raw}"'
    if canonical_for_layer:
        data_attrs += f' data-field="{canonical_for_layer}"'

    if l.get("hide"):
        base_style += "display:none;"

    if typ == "shape":
        # shapes include raw SVG in l['html']; wrap it at the right position
        svg_html = l.get("html") or ""
        fill_bg = l.get("fill") or l.get("background")
        if not svg_html and fill_bg:
            svg_html = f'<div style="width:100%;height:100%;background:{css_color(fill_bg)};"></div>'
        return f'<div style="{base_style}"{data_attrs}>{svg_html}</div>'

    if typ == "image":
        url = l.get("image_url") or ""
        fit = l.get("object_fit") or "cover"
        pos = l.get("object_position") or "center"
        if canonical_for_layer:
            # leave a placeholder img tag that the renderer swaps in
            src = f"{{{{{canonical_for_layer}}}}}"
        else:
            src = url
        img_style = (
            f"width:100%;height:100%;object-fit:{fit};object-position:{pos};"
        )
        return (
            f'<div style="{base_style}"{data_attrs}>'
            f'<img src="{src}" style="{img_style}" />'
            f'</div>'
        )

    if typ == "text":
        color = css_color(l.get("color"))
        raw_fam = l.get("font_family") or "sans-serif"
        fam, parsed_weight, italic = parse_font(raw_fam)
        size = l.get("font_size") or "16px"
        # explicit font_weight in the layer spec wins over the suffix-parsed one
        explicit_weight = l.get("font_weight")
        if explicit_weight:
            # templated sometimes sends "bold" or "700"
            if str(explicit_weight).lower() in WEIGHT_WORDS:
                weight = WEIGHT_WORDS[str(explicit_weight).lower()]
            else:
                try:
                    weight = int(explicit_weight)
                except (TypeError, ValueError):
                    weight = parsed_weight
        else:
            weight = parsed_weight
        style = "italic" if italic else "normal"
        ls = l.get("letter_spacing")
        lh = l.get("line_height")
        halign = text_align(l.get("horizontal_align"))
        valign = flex_align(l.get("vertical_align"))

        # autofit: templated shrinks text to fit the box. approximate with css clamp where possible.
        base_style += (
            f"color:{color};font-family:'{fam}',sans-serif;font-size:{size};"
            f"font-weight:{weight};font-style:{style};text-align:{halign};"
            f"display:flex;align-items:{valign};justify-content:"
            f"{'flex-start' if halign == 'left' else 'center' if halign == 'center' else 'flex-end'};"
            f"overflow:hidden;word-break:break-word;line-height:1.15;"
        )
        if ls:
            base_style += f"letter-spacing:{ls};"
        if lh:
            base_style += f"line-height:{lh};"
        if l.get("background"):
            base_style += f"background:{css_color(l['background'])};"
        if l.get("padding_x"):
            base_style += f"padding-left:{px(l['padding_x'])};padding-right:{px(l['padding_x'])};"
        if l.get("padding_y"):
            base_style += f"padding-top:{px(l['padding_y'])};padding-bottom:{px(l['padding_y'])};"

        if canonical_for_layer:
            content = f"{{{{{canonical_for_layer}}}}}"
        else:
            content = strip_html(l.get("text") or "")

        return f'<div style="{base_style}"{data_attrs}><span>{content}</span></div>'

    # unknown layer type
    return f'<!-- unknown layer type: {typ} ({raw}) -->'


def collect_fonts(layers):
    """Returns dict of {family: {'has_italic': bool}} so we can request italic axis when needed."""
    fams = {}
    for l in layers:
        for key in ("font_family", "font_family_2"):
            raw = l.get(key)
            if not raw:
                continue
            fam, _w, italic = parse_font(raw)
            entry = fams.setdefault(fam, {"has_italic": False})
            if italic:
                entry["has_italic"] = True
    return fams


def google_fonts_link(fams):
    if not fams:
        return ""
    parts = []
    for fam, meta in sorted(fams.items()):
        name = fam.replace(" ", "+")
        if meta["has_italic"]:
            # ital,wght axis needs both styles listed
            parts.append(f"{name}:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700")
        else:
            parts.append(f"{name}:wght@400;500;600;700")
    href = "https://fonts.googleapis.com/css2?" + "&".join(f"family={p}" for p in parts) + "&display=swap"
    return f'<link rel="stylesheet" href="{href}">'


def convert(name):
    meta = json.loads((SRC / f"{name}.meta.json").read_text())
    layers = json.loads((SRC / f"{name}.layers.json").read_text())
    w, h = meta["width"], meta["height"]
    bg = meta.get("background") or "white"

    unmapped = []
    pieces = []
    for l in layers:
        raw = l["layer"]
        canonical = RAW_TO_CANONICAL.get(raw)
        if canonical is None and raw not in STATIC:
            unmapped.append(raw)
        pieces.append(render_layer(l, canonical))

    fonts = collect_fonts(layers)
    fonts_link = google_fonts_link(fonts)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{meta.get('name', name)}</title>
{fonts_link}
<style>
  html, body {{ margin: 0; padding: 0; }}
  body {{ background: {bg}; }}
  #canvas {{
    position: relative;
    width: {w}px;
    height: {h}px;
    background: {bg};
    overflow: hidden;
  }}
  #canvas img {{ display: block; }}
  #canvas span {{ white-space: pre-wrap; }}
</style>
</head>
<body>
<div id="canvas" data-template="{name}" data-width="{w}" data-height="{h}">
{chr(10).join(pieces)}
</div>
</body>
</html>
"""
    out_path = OUT / f"{name}.html"
    out_path.write_text(html)
    return out_path, unmapped


def main():
    names = sys.argv[1:] or [
        Path(f).name.replace(".meta.json", "")
        for f in sorted(glob.glob(str(SRC / "*.meta.json")))
    ]
    all_unmapped = {}
    for name in names:
        out, unmapped = convert(name)
        print(f"wrote {out.relative_to(SKILL)}")
        if unmapped:
            all_unmapped[name] = unmapped
    if all_unmapped:
        print("\nUNMAPPED LAYERS (not in semantic-map.json, kept as static):")
        for k, v in all_unmapped.items():
            print(f"  {k}: {v}")
    else:
        print("\nall layers mapped or flagged static.")


if __name__ == "__main__":
    main()
