#!/usr/bin/env python3
"""Frozen STUDIO toolbar/adapter → real local STUDIO HTTP/SQL worker → decode each output.

Requires TEST_DATABASE_URL (disposable database factory), ffmpeg, ffprobe, Go, Node.
Signature/token data and raw output URLs are not stored in evidence. Creates a
new output directory, a temporary schema, synthetic inputs and ten local jobs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import struct
import subprocess
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
if not os.getenv('TEST_DATABASE_URL'):
    parser.error('TEST_DATABASE_URL is required')
ffmpeg = shutil.which(os.getenv('TEST_FFMPEG_PATH', 'ffmpeg'))
probe = shutil.which(os.getenv('STUDIO_TEST_FFPROBE', 'ffprobe'))
if not ffmpeg or not probe:
    parser.error('ffmpeg and ffprobe are required')
root = Path(__file__).resolve().parents[1]
api = root / 'apps/api-go'
out = args.out.resolve()
out.mkdir(exist_ok=False, parents=True)
(out/'bin').mkdir()
(out/'bin/ffmpeg').symlink_to(Path(ffmpeg).resolve())
runpy.run_path(str(root/'tools/canvas-router-audit/media.py'))['write'](root, out)
# The generic Router fixture has static video. Use an asymmetric gradient that
# changes over time to discriminate wrong rotation, mirroring and seek direction.
original = out / 'moving-source.mp4'
subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i',
                "nullsrc=size=640x360:rate=24,geq=lum='32+95*X/W+23*Y/H+75*T/6':cb='67+99*Y/H':cr='71+103*X/W'",
                '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','6','-c:v','libx264','-preset','ultrafast',
                '-pix_fmt','yuv420p','-c:a','aac',str(original)], check=True,timeout=30)
manifest_path=out/'assets.json'
manifest=json.loads(manifest_path.read_text())
data=original.read_bytes(); sha=hashlib.sha256(data).hexdigest(); (out/'media'/sha).write_bytes(data)
manifest['a-video'].update(Sha=sha,Size=len(data));manifest_path.write_text(json.dumps(manifest))

def pixels(file, second, filters):
    return subprocess.check_output([ffmpeg,'-v','error','-ss',str(second),'-i',str(file),'-map','0:v:0',
                                    '-frames:v','1','-vf',','.join([*filters,'scale=32:24']),
                                    '-f','rawvideo','-pix_fmt','rgb24','-'],timeout=15)

# Independent expected transform for each button; not copied from the submitted body.
expected_filter = {'裁剪':['crop=160:120:0:0'],'右转':['transpose=clock'],'左转':['transpose=cclock'],
                   '水平镜像':['hflip'],'垂直镜像':['vflip'],'旋转加镜像':['transpose=clock','vflip']}
cases = out / 'media-cases.jsonl'
subprocess.run(['npm', 'run', 'test:web', '--', 'tests/web/native-media-actions-boundary.test.ts'], env=dict(os.environ, STUDIO_CANVAS_MEDIA_EXPORT=str(cases)), cwd=root, check=True)
subprocess.run(['go', 'test', '-tags=canvas_boundary_audit', '-c', '-o', str(out/'studio.test'), './internal/bootstrap'], cwd=api, check=True)
env = dict(os.environ, PATH=str(out/'bin')+os.pathsep+os.environ['PATH'], STUDIO_CANVAS_BOUNDARY_DIR=str(out),
           STUDIO_CANVAS_BOUNDARY_MEDIA_ONLY='1', STUDIO_TEST_FFPROBE=probe)
rows = [json.loads(line) for line in cases.read_text().splitlines()]
assert len(rows) == len({row['name'] for row in rows}) == 10
results = []
with (out/'studio.log').open('w') as log:
    srv = subprocess.Popen([str(out/'studio.test'), '-test.run=^TestCanvasAuditHTTPBoundary$', '-test.v', '-test.timeout=8m'], env=env, cwd=api/'internal/bootstrap', stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(900):
            if (out/'origin').exists(): break
            if srv.poll() is not None: raise RuntimeError('STUDIO exited; inspect studio.log')
            time.sleep(.1)
        origin=(out/'origin').read_text()
        assert re.fullmatch(r'http://127\.0\.0\.1:\d+', origin)
        def fetch(path, body=None, raw=False):
            headers = {'Authorization': 'Bearer test-access'}
            if body is not None: headers.update({'Content-Type': 'application/json', 'Idempotency-Key': str(uuid.uuid4())})
            assert path.startswith('/') and not path.startswith('//')
            req=Request(origin+path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
            with urlopen(req,timeout=20) as resp: data=resp.read()
            return data if raw else json.loads(data)['data']
        for row in rows:
            name,body=row['name'],row['body']
            try:
                result=fetch('/api/v2/media-jobs',body); task=result['taskId']
                for _ in range(420):
                    result=fetch('/api/v2/media-jobs/'+task)
                    if result['state'] not in {'QUEUED','RUNNING'}: break
                    time.sleep(.2)
                assert result['state']=='SUCCEEDED' and len(result['outputs'])==1, (result['state'],result.get('errorCode'))
                output=result['outputs'][0]; resource=urlsplit(output['url'])
                content=fetch(resource.path+('?'+resource.query if resource.query else ''), raw=True)
                audio=body['operation']=='EXTRACT_AUDIO'; file=out/(task+('.wav' if audio else '.mp4'))
                file.write_bytes(content)
                info=json.loads(subprocess.check_output([probe,'-v','error','-show_entries','format=duration:stream=codec_type,codec_name,width,height','-of','json',str(file)]))
                streams={s['codec_type']:s for s in info['streams']};sec=float(info['format']['duration'])
                clip=body['spec']['tracks'][0]['clips'][0]
                expected=6/float(clip.get('speed',1))
                assert abs(sec-expected)<.25,(sec,expected)
                pixel_error=None
                if audio:
                    assert list(streams)==['audio'] and streams['audio']['codec_name'].startswith('pcm_'),streams
                    raw=subprocess.check_output([ffmpeg,'-v','error','-ss','1','-i',str(file),'-t','0.2','-ac','1','-ar','8000','-f','s16le','-'])
                    amplitude=[abs(a[0]) for a in struct.iter_unpack('<h',raw)]
                    assert max(amplitude)>500 and len(amplitude)>=1500, 'extracted audio is empty or silent'
                else:
                    assert streams['video']['codec_name']=='h264' and streams['audio']['codec_name']=='aac',streams
                    width,height=(640,360)
                    if clip.get('crop'): width,height=clip['crop']['width'],clip['crop']['height']
                    if clip.get('rotate') in {'90','270'}: width,height=height,width
                    assert (streams['video']['width'],streams['video']['height'])==(width,height),(streams,width,height)
                    second=.75
                    source_t=6-second-1/24 if name=='倒放' else second*{'最高速':4,'最低速':.25}.get(name,1)
                    actual=pixels(file,second,[]); expected_pixels=pixels(original,source_t,expected_filter.get(name,[]))
                    assert len(actual)==len(expected_pixels)==32*24*3
                    pixel_error=sum(abs(a-b) for a,b in zip(actual,expected_pixels))/len(actual)
                    assert pixel_error<3,(name,'mean RGB error at 0.75 seconds:',pixel_error)
                subprocess.run([ffmpeg,'-v','error','-xerror','-i',str(file),'-f','null','-'],check=True,timeout=30)
                results.append(dict(name=name,taskId=task,operation=body['operation'],assetId=output['assetId'],duration=sec,streams=info['streams'],bytes=len(content),meanRGBError=pixel_error))
            except Exception as e: raise RuntimeError(f'{name} validation failed: {e}') from e
    finally:
        (out/'finished').touch()
        try: srv.wait(timeout=20)
        except subprocess.TimeoutExpired: srv.terminate();srv.wait()
        (out/'media-results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False)+'\n')
if srv.returncode: raise RuntimeError('STUDIO completion check failed; inspect studio.log')
print(f'{len(results)}/10 real STUDIO media tasks completed, imported, downloaded and decoded.')
