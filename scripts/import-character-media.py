#!/usr/bin/env python3
"""Capture/reproduce the explicit STUDIO character image catalog; never invoked by API reads.

--capture creates a versioned manifest from the already captured character fixtures.
--download reproduces missing cached bytes from the committed manifest; drift fails closed.
--verify is offline and validates every SHA256, byte count and decoded WebP dimensions.
Only public, allowlisted character CDN sources are used. No auth, model or paid API is called.
Binaries live under ignored .local/catalog/studio-character-media, never frozen Web assets/Git.
"""
import argparse, concurrent.futures, hashlib, json, os, re, struct, sys, tempfile, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'apps/api-go/internal/modules/resources/adapters/postgres/seed/character-media.json'
PREFIX = '/studio-character-media/'
VERSION = 'studio-character-media-1'
BASE_VERSION = 'captured-2026-10-05-v2'
MAX_BYTES = 8 * 1024 * 1024
SOURCE = re.compile(r'https://rh-canvas-files\.xiaoyaoyou\.com/characterPortraitLibrary/[A-Za-z0-9_/-]+\.jpg\Z')
VIEWS = ('closeUp', 'fullBody', 'multiView')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def webp_size(body):
    if len(body) < 30 or body[:4] != b'RIFF' or body[8:12] != b'WEBP' or struct.unpack('<I', body[4:8])[0] != len(body) - 8:
        raise ValueError('invalid WebP container')
    chunk = body[12:16]
    if chunk == b'VP8X':
        return 1 + int.from_bytes(body[24:27], 'little'), 1 + int.from_bytes(body[27:30], 'little')
    if chunk == b'VP8 ' and body[23:26] == b'\x9d\x01\x2a':
        width, height = struct.unpack('<HH', body[26:30])
        return width & 0x3fff, height & 0x3fff
    if chunk == b'VP8L' and body[20] == 0x2f:
        bits = int.from_bytes(body[21:25], 'little')
        return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
    raise ValueError('unsupported WebP dimensions')


def metadata(body):
    width, height = webp_size(body)
    if len(body) > MAX_BYTES or not 1 <= width <= 768 or not 1 <= height <= 4096:
        raise ValueError('invalid character rendition bounds')
    digest = hashlib.sha256(body).hexdigest()
    return {'path': PREFIX + digest + '.webp', 'sha256': digest, 'byteSize': len(body), 'width': width, 'height': height, 'mimeType': 'image/webp'}


def source_url(source, rendition):
    if not SOURCE.fullmatch(source):
        raise ValueError('untrusted source URL')
    width, quality = (240, 65) if rendition == 'thumbnail' else (768, 80)
    return source + '?imageMogr2/thumbnail/' + str(width) + 'x/quality/' + str(quality) + '/format/webp/strip/1'


def fetch(source, rendition):
    url = source_url(source, rendition)
    # Redirects are intentionally disallowed; the allowlisted original must serve its bytes.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = urllib.request.Request(url, headers={'User-Agent': 'STUDIO-Character-Catalog/1'})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=45) as response:
        if response.status != 200 or response.headers.get_content_type() != 'image/webp':
            raise ValueError('source did not return WebP')
        body = response.read(MAX_BYTES + 1)
    return body


def cached_path(cache, media):
    if media['path'] != PREFIX + media['sha256'] + '.webp' or not re.fullmatch(r'[a-f0-9]{64}', media['sha256']):
        raise ValueError('invalid manifest media path')
    return cache / (media['sha256'] + '.webp')


def verify_body(body, media):
    got = metadata(body)
    if any(got[key] != media[key] for key in got):
        raise ValueError('cached/source content differs from versioned manifest')
    if media['rendition'] == 'thumbnail' and got['width'] > 240:
        raise ValueError('invalid thumbnail width')


def write_cache(cache, body, media):
    target = cached_path(cache, media)
    if target.exists():
        if target.is_symlink():
            raise ValueError('cache symlink rejected')
        verify_body(target.read_bytes(), media)
        return
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix='.character-', dir=cache, delete=False) as temporary:
        name = temporary.name
        temporary.write(body)
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        os.chmod(name, 0o644)
        os.link(name, target)
    finally:
        os.unlink(name)


def source_rows():
    raw = (ROOT / 'apps/web/public/fixtures.json').read_bytes()
    rows = {}
    for fixture in json.loads(raw):
        if urllib.parse.urlparse(fixture['url']).path != '/canvas/character-library/list' or fixture['body'].get('code') != 0:
            continue
        for row in fixture['body']['data']['records']:
            if row['id'] in rows and rows[row['id']] != row:
                raise ValueError('captured character changed across fixture pages')
            rows[row['id']] = row
    if len(rows) != 415:
        raise ValueError('unexpected captured character count')
    return hashlib.sha256(raw).hexdigest(), sorted(rows.values(), key=lambda row: int(row['id']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', action='store_true')
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    parser.add_argument('--cache', type=Path, default=ROOT / '.local/catalog/studio-character-media')
    parser.add_argument('--workers', type=int, default=12)
    args = parser.parse_args()
    if sum((args.capture, args.download, args.verify)) != 1 or not 1 <= args.workers <= 24:
        parser.error('select exactly one mode and 1–24 workers')
    if args.capture:
        if args.manifest.exists():
            parser.error('capture never replaces an existing versioned manifest')
        fixture_hash, rows = source_rows()
        tasks = []
        characters = []
        for row in rows:
            images = {image['type']: image for image in row['images']}
            if tuple(images) != VIEWS:
                raise ValueError('unexpected captured character views')
            character = {'id': str(row['id']), 'images': []}
            for view in VIEWS:
                image = images[view]
                character['images'].append({'name': image['name'], 'type': view, 'sourceUrl': image['url']})
                tasks.append((str(row['id']), view, 'view', image['url']))
            tasks.append((str(row['id']), 'closeUp', 'thumbnail', images['closeUp']['url']))
            characters.append(character)
        # Download all thumbnails first; the independent view batch follows.
        tasks.sort(key=lambda task: task[2] != 'thumbnail')
        def capture(task):
            ident, view, rendition, source = task
            body = fetch(source, rendition)
            media = {**metadata(body), 'sourceUrl': source, 'rendition': rendition}
            write_cache(args.cache, body, media)
            return ident, view, rendition, media
        captured = {}
        with concurrent.futures.ThreadPoolExecutor(args.workers) as executor:
            for index, result in enumerate(executor.map(capture, tasks), 1):
                ident, view, rendition, media = result
                captured[(ident, view, rendition)] = media
                if index % 100 == 0:
                    print('captured', index, '/', len(tasks), flush=True)
        baseline = json.loads((MANIFEST.parent / 'catalog.json').read_bytes())
        resource_ids = {str(row['content']['id']): row['id'] for row in baseline['items'] if row['family'] == 'CHARACTER'}
        media_by_path = {}
        for character in characters:
            character['thumbnailPath'] = captured[(character['id'], 'closeUp', 'thumbnail')]['path']
            for image in character['images']:
                image['url'] = captured[(character['id'], image['type'], 'view')]['path']
                image.pop('sourceUrl')
            character['id'] = resource_ids[character['id']]
        for media in captured.values():
            if media['path'] in media_by_path and media_by_path[media['path']] != media:
                raise ValueError('ambiguous identical rendition provenance')
            media_by_path[media['path']] = media
        result = {'version': VERSION, 'baseVersion': BASE_VERSION, 'fixtureSHA256': fixture_hash, 'sourceName': 'Captured 415 public character portraits; explicit offline CDN WebP rendition import', 'characters': characters, 'media': sorted(media_by_path.values(), key=lambda media: media['path'])}
        args.manifest.write_bytes(canonical(result) + b'\n')
    else:
        result = json.loads(args.manifest.read_bytes())
        if result['version'] != VERSION or result['baseVersion'] != BASE_VERSION or len(result['characters']) != 415:
            raise ValueError('unexpected character manifest identity')
        def reproduce(media):
            path = cached_path(args.cache, media)
            if path.is_symlink():
                raise ValueError('cache symlink rejected')
            if path.is_file():
                verify_body(path.read_bytes(), media)
            elif args.download:
                body = fetch(media['sourceUrl'], media['rendition'])
                verify_body(body, media)
                write_cache(args.cache, body, media)
            else:
                raise ValueError('cached character file missing: ' + path.name)
        with concurrent.futures.ThreadPoolExecutor(args.workers) as executor:
            for _ in executor.map(reproduce, result['media']):
                pass
    print(json.dumps({'version': result['version'], 'characters': len(result['characters']), 'files': len(result['media']), 'bytes': sum(media['byteSize'] for media in result['media']), 'mode': 'capture' if args.capture else 'download' if args.download else 'verify'}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Character cache failed:', str(error), file=sys.stderr)
        sys.exit(1)
