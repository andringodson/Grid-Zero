"""
Downloads the game's photographic assets into public/assets/. Every asset is CC0 (public domain): skies and some
surfaces from Poly Haven (polyhaven.com), grass from ambientCG (ambientcg.com). Needs Python 3 with Pillow.

    python scripts/fetch-assets.py

Skies: an HDR at 2K and 1K (lighting and reflections; the sun's direction is read from it) and the photographer's
tonemapped JPEG, shrunk to 8K and 4K wide (the visible sky). Surfaces: colour, normal (OpenGL) and roughness at 2K and
1K. The 1K and 4K versions are for the low and medium graphics tiers.
"""
import io
import json
import os
import urllib.request
import zipfile

from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets')
UA = {'User-Agent': 'grid-zero-asset-fetch/1.0'}

SKIES = {
    'midday': 'kloofendal_48d_partly_cloudy_puresky',
    'afternoon': 'sunflowers_puresky',
    'sunset': 'belfast_sunset_puresky',
    'overcast': 'overcast_soil_puresky',
}
POLYHAVEN_SURFACES = {'asphalt': 'asphalt_pit_lane', 'gravel': 'gravel_floor_02'}
AMBIENTCG_SURFACES = {'grass': 'Grass001', 'meadow': 'Grass004'}


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        return r.read()


def save_jpeg(img: Image.Image, path: str, width: int, quality: int = 88) -> None:
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img.convert('RGB').save(path, quality=quality, optimize=True)
    print('  wrote', os.path.relpath(path, ROOT), f'{os.path.getsize(path) / 1e6:.1f} MB')


def skies() -> None:
    out = os.path.join(ROOT, 'sky')
    os.makedirs(out, exist_ok=True)
    for key, asset in SKIES.items():
        print('sky', key, asset)
        files = json.loads(get(f'https://api.polyhaven.com/files/{asset}'))
        for res in ('2k', '1k'):
            path = os.path.join(out, f'{key}_{res}.hdr')
            with open(path, 'wb') as f:
                f.write(get(files['hdri'][res]['hdr']['url']))
            print('  wrote', os.path.relpath(path, ROOT), f'{os.path.getsize(path) / 1e6:.1f} MB')
        photo = Image.open(io.BytesIO(get(files['tonemapped']['url'])))
        save_jpeg(photo, os.path.join(out, f'{key}_8k.jpg'), 8192)
        save_jpeg(photo, os.path.join(out, f'{key}_4k.jpg'), 4096)


def surfaces() -> None:
    out = os.path.join(ROOT, 'surface')
    os.makedirs(out, exist_ok=True)
    maps = {'Diffuse': 'color', 'nor_gl': 'normal', 'Rough': 'rough'}
    for key, asset in POLYHAVEN_SURFACES.items():
        print('surface', key, asset)
        files = json.loads(get(f'https://api.polyhaven.com/files/{asset}'))
        for src, name in maps.items():
            img = Image.open(io.BytesIO(get(files[src]['2k']['jpg']['url'])))
            save_jpeg(img, os.path.join(out, f'{key}_{name}_2k.jpg'), 2048, 90)
            save_jpeg(img, os.path.join(out, f'{key}_{name}_1k.jpg'), 1024, 90)
    suffixes = {'_Color.jpg': 'color', '_NormalGL.jpg': 'normal', '_Roughness.jpg': 'rough'}
    for key, asset in AMBIENTCG_SURFACES.items():
        print('surface', key, asset)
        archive = zipfile.ZipFile(io.BytesIO(get(f'https://ambientcg.com/get?file={asset}_2K-JPG.zip')))
        for member in archive.namelist():
            for suffix, name in suffixes.items():
                # Only the expected image names, read in memory: nothing from the archive is written as is.
                if member == f'{asset}_2K-JPG{suffix}':
                    img = Image.open(io.BytesIO(archive.read(member)))
                    save_jpeg(img, os.path.join(out, f'{key}_{name}_2k.jpg'), 2048, 90)
                    save_jpeg(img, os.path.join(out, f'{key}_{name}_1k.jpg'), 1024, 90)


if __name__ == '__main__':
    skies()
    surfaces()
