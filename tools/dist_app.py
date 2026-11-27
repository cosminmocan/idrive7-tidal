#!/usr/bin/env python3
"""dist_app.py <app id> <out dir> - the car app as an OAP package for the Store, without BMW's SDK in it.

    python3 tools/dist_app.py cmocan_tidal dist/idrive7-tidal

Writes <out dir>/<id>@<version>.tgz (npm format, the files under package/) and <out dir>/<id>.png (its icon).

The kit's build.py (kit/tools, unchanged) makes the package, but it wants BMW's oap-sdk to copy into
node_modules/oap-sdk. The Store's deploy tool generates that module on the head unit from a stock BMW app (its donor)
when a package calls require('oap-sdk') and ships none (mgu-store deploy/README.md, "Packages built elsewhere";
docs/PUBLISHING.md, "Leave out node_modules/oap-sdk"). So build.py is given two placeholder files of our own instead
of the SDK, and node_modules/ is taken out of the package again: no SDK file is ever read or packed (rule R10).
A real oap-sdk/ in the checkout is never used.

The package also gets "mguHmi" from app.json (build.py does not write it). The archive is deterministic: sorted
names, owner 0:0, one mtime, a gzip header without a time.
"""
import calendar, gzip, io, json, os, shutil, sys, tarfile, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
sys.path.insert(0, os.path.join(ROOT, 'kit', 'tools'))
import build  # noqa: E402  (kit/tools/build.py)

# the same fixed time as mgu-store's packer (tools/oap_pack.js MTIME)
MTIME = calendar.timegm((2026, 10, 18, 0, 0, 0))
PLACEHOLDER = '/* not BMW\'s oap-sdk: a placeholder for kit/tools/build.py; tools/dist_app.py takes it out of the package */\n'


def pack(src, out):
    """src (the staged source/ folder) as out, its files under package/"""
    names = []
    for d, dirs, files in os.walk(src):
        dirs.sort()
        rel = os.path.relpath(d, src)
        names.append(rel)
        names.extend(os.path.join(rel, f) for f in sorted(files))
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as tf:
        for rel in names:
            p = os.path.join(src, rel)
            arc = 'package' if rel == '.' else 'package/' + os.path.normpath(rel).replace(os.sep, '/')
            ti = tarfile.TarInfo(arc)
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ''
            ti.mtime = MTIME
            if os.path.isdir(p):
                ti.type, ti.mode = tarfile.DIRTYPE, 0o755
                tf.addfile(ti)
            else:
                data = open(p, 'rb').read()
                ti.size, ti.mode = len(data), (0o755 if os.stat(p).st_mode & 0o111 else 0o644)
                tf.addfile(ti, io.BytesIO(data))
    with open(out, 'wb') as f, gzip.GzipFile(fileobj=f, mode='wb', mtime=0, filename='') as gz:
        gz.write(buf.getvalue())


def main(app_id, out_dir):
    spec = json.load(open(os.path.join(ROOT, 'apps', app_id, 'app.json'), encoding='utf-8'))
    app_id, ver = spec.get('id', app_id), spec['version']
    with tempfile.TemporaryDirectory(prefix='cmocan-no-sdk-') as stand_in:
        for name, text in (('index.js', PLACEHOLDER), ('package.json', '{"name": "oap-sdk-placeholder", "version": "0.0.0"}\n')):
            with open(os.path.join(stand_in, name), 'w', encoding='utf-8') as f:
                f.write(text)
        build.SDK = stand_in
        build.build(app_id)
    stage = os.path.join(build.DIST, app_id)
    # build.py's own archives hold the placeholder: not for anybody
    for ext in ('mgu', 'tgz'):
        p = os.path.join(build.DIST, '%s@%s.%s' % (app_id, ver, ext))
        if os.path.exists(p):
            os.remove(p)
    src = os.path.join(stage, 'source')
    modules = os.path.join(src, 'node_modules')
    if sorted(os.listdir(modules)) != ['oap-sdk']:
        raise SystemExit('dist_app.py: node_modules holds more than the placeholder: %s' % os.listdir(modules))
    shutil.rmtree(modules)
    pkg_file = os.path.join(src, 'package.json')
    pkg = json.load(open(pkg_file, encoding='utf-8'))
    if spec.get('mguHmi'):
        pkg['mguHmi'] = spec['mguHmi']
    with open(pkg_file, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(pkg, f, indent=2)
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, '%s@%s.tgz' % (app_id, ver))
    pack(src, out)
    icon = os.path.join(src, 'rhmiData', 'variantGroups', 'Common', 'images', app_id + '_icon.png')
    shutil.copy(icon, os.path.join(out_dir, app_id + '.png'))
    print('%s %s: %s (%d bytes, no node_modules: the head unit generates oap-sdk from its donor)'
          % (app_id, ver, os.path.relpath(out, ROOT), os.path.getsize(out)))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: dist_app.py <app id> <out dir>')
    main(sys.argv[1], sys.argv[2])
