#!/usr/bin/env python3
"""Зсуває холодні кольори MapLibre-стилю в теплий бік (hex / rgb(a) / hsl(a)).

Використання:
    python3 warm_style.py style-dark.json  style-dark.warm.json  dark
    python3 warm_style.py style-light.json style-light.warm.json light
"""
import colorsys
import json
import re
import sys
from collections import OrderedDict

# ---------------- НАЛАШТУВАННЯ ----------------
TARGET_HUE = 30 / 360          # теплий коричнево-бежевий відтінок
COOL_RANGE = (170 / 360, 306 / 360)   # від блакитного до фіолетового
COOL_SAT_FACTOR = 0.65         # наскільки зменшити насиченість холодних кольорів
COOL_SAT_CAP = 0.20            # верхня межа насиченості після зсуву
NEUTRAL_SAT_MAX = 0.04         # нижче цього вважаємо колір нейтрально-сірим
NEUTRAL_TINT_SAT = 0.05        # легкий теплий відтінок для сірих
KEEP_EXTREMES = (0.03, 0.97)   # майже чорне/біле не чіпаємо

# Шари, які не чіпаємо (вода лишається холодною)
EXCLUDE_LAYERS = re.compile(r'^(water|waterway)')

# Точні значення для окремих шарів (щоб карта збігалась з палітрою інтерфейсу)
OVERRIDES = {
    'dark': {
        ('background', 'background-color'): '#2a2623',
    },
    'light': {
        ('background', 'background-color'): 'rgba(235, 230, 222, 0.95)',
    },
}
# ----------------------------------------------

HEX_RE = re.compile(r'^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')
RGB_RE = re.compile(r'^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$')
HSL_RE = re.compile(r'^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$')


def parse_color(s):
    """-> (r, g, b, a, fmt) з r,g,b у 0..1, або None, якщо це не колір."""
    s = s.strip()
    m = HEX_RE.match(s)
    if m:
        h = m.group(1)
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h)
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return r, g, b, a, 'hex'
    m = RGB_RE.match(s)
    if m:
        r, g, b = (float(m.group(i)) / 255 for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return r, g, b, a, ('rgba' if m.group(4) is not None else 'rgb')
    m = HSL_RE.match(s)
    if m:
        h, sat, l = float(m.group(1)) / 360, float(m.group(2)) / 100, float(m.group(3)) / 100
        r, g, b = colorsys.hls_to_rgb(h, l, sat)
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return r, g, b, a, ('hsla' if m.group(4) is not None else 'hsl')
    return None


def fmt_alpha(a):
    return ('%.2f' % a).rstrip('0').rstrip('.') or '0'


def format_color(r, g, b, a, fmt):
    r8, g8, b8 = (max(0, min(255, round(x * 255))) for x in (r, g, b))
    if fmt == 'hex':
        base = '#%02x%02x%02x' % (r8, g8, b8)
        return base if a >= 0.999 else base + '%02x' % round(a * 255)
    if fmt in ('rgb', 'rgba'):
        if fmt == 'rgb':
            return 'rgb(%d, %d, %d)' % (r8, g8, b8)
        return 'rgba(%d, %d, %d, %s)' % (r8, g8, b8, fmt_alpha(a))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    hs = '%d, %d%%, %d%%' % (round(h * 360) % 360, round(s * 100), round(l * 100))
    return 'hsl(%s)' % hs if fmt == 'hsl' else 'hsla(%s, %s)' % (hs, fmt_alpha(a))


def warm(color):
    """Повертає новий рядок кольору або None, якщо змінювати не треба."""
    p = parse_color(color)
    if p is None:
        return None
    r, g, b, a, fmt = p
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if l <= KEEP_EXTREMES[0] or l >= KEEP_EXTREMES[1]:
        return None
    if s < NEUTRAL_SAT_MAX:
        nh, ns = TARGET_HUE, NEUTRAL_TINT_SAT          # сірі -> трохи теплі
    elif COOL_RANGE[0] <= h <= COOL_RANGE[1]:
        nh, ns = TARGET_HUE, min(s * COOL_SAT_FACTOR, COOL_SAT_CAP)  # холодні -> теплі
    else:
        return None                                    # зелені, жовті, червоні лишаємо
    nr, ng, nb = colorsys.hls_to_rgb(nh, l, ns)
    new = format_color(nr, ng, nb, a, fmt)
    return new if new.lower().replace(' ', '') != color.lower().replace(' ', '') else None


def walk(node, changes, ctx):
    """Рекурсивно проходить значення (рядки, масиви, stops, вирази)."""
    if isinstance(node, str):
        new = warm(node)
        if new is not None:
            changes.append((ctx, node, new))
            return new
        return node
    if isinstance(node, list):
        return [walk(x, changes, ctx) for x in node]
    if isinstance(node, dict):
        return OrderedDict((k, walk(v, changes, ctx)) for k, v in node.items())
    return node


def main(src, dst, mode):
    data = json.load(open(src, encoding='utf-8'), object_pairs_hook=OrderedDict)
    overrides = OVERRIDES[mode]
    changes = []
    skipped = 0
    for layer in data['layers']:
        lid = layer['id']
        paint = layer.get('paint')
        if not paint:
            continue
        for prop in list(paint.keys()):
            if 'color' not in prop:
                continue
            if (lid, prop) in overrides:
                changes.append(((lid, prop), paint[prop], overrides[(lid, prop)]))
                paint[prop] = overrides[(lid, prop)]
            elif EXCLUDE_LAYERS.match(lid):
                skipped += 1
            else:
                paint[prop] = walk(paint[prop], changes, (lid, prop))
    # Зберігаємо оригінальне форматування: міняємо кольори прямо в тексті,
    # а потім перевіряємо, що результат семантично збігається з обчисленим.
    raw = open(src, encoding='utf-8').read()
    pairs = OrderedDict(((o, n), None) for _, o, n in changes)
    out = raw
    for (o, n) in pairs:
        out = out.replace(json.dumps(o, ensure_ascii=False), json.dumps(n, ensure_ascii=False))
    if json.loads(out, object_pairs_hook=OrderedDict) == data:
        text = out
    else:
        print('УВАГА: текстова заміна не збіглась, пишу через json.dump (форматування зміниться)')
        text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(text)
    print('%s -> %s' % (src, dst))
    print('змінено значень: %d, пропущено водних властивостей: %d' % (len(changes), skipped))
    seen = OrderedDict()
    for (lid, prop), old, new in changes:
        seen.setdefault((old, new), []).append(lid)
    for (old, new), layers in seen.items():
        short = ', '.join(layers[:3]) + (' +%d' % (len(layers) - 3) if len(layers) > 3 else '')
        print('  %-26s -> %-26s %s' % (old, new, short))


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[3] not in OVERRIDES:
        sys.exit(__doc__)
    main(*sys.argv[1:])
