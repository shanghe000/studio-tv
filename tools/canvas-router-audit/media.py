"""Small synthetic PNG, H.264 and PCM inputs for the isolated PG chain."""
import hashlib, io, json, pathlib, struct, wave, zlib
def write(root, directory):
    media=directory/'media';media.mkdir(exist_ok=True);manifest={}
    def png(color):
        def chunk(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
        row=b'\0'+bytes(color)*640
        return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',640,360,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(row*360))+chunk(b'IEND',b'')
    def item(id,kind,mime,body):
        sha=hashlib.sha256(body).hexdigest();(media/sha).write_bytes(body)
        manifest[id]=dict(Kind=kind,Mime=mime,Sha=sha,Size=len(body),Width=0 if kind=='AUDIO' else 640,Height=0 if kind=='AUDIO' else 360,Duration=0 if kind=='IMAGE' else 6)
    video=(root/'tests/fixtures/canvas-boundary/synthetic-6s.mp4').read_bytes()
    for i,id in enumerate(['a','b','b2','owned','guide','reference','image']):
        item(id if i>=3 else id+'-image','IMAGE','image/png',png((80,60+i,128)))
    for i,id in enumerate(['a','b','b2']):
        # A valid MP4 padding atom distinguishes fixture bytes as well as asset IDs.
        item(id+'-video','VIDEO','video/mp4',video+struct.pack('>I4sB',9,b'free',i))
        buf=io.BytesIO()
        with wave.open(buf,'wb') as w:w.setparams((1,2,16000,96000,'NONE',''));w.writeframes(bytes([i,0])*96000)
        item(id+'-audio','AUDIO','audio/wav',buf.getvalue())
    (directory/'assets.json').write_text(json.dumps(manifest))
