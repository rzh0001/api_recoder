# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['webview.platforms.edgechromium', 'clr', 'simple_websocket', 'simple_websocket.ws', 'websockets', 'websocket']
hiddenimports += collect_submodules('webview')
hiddenimports += collect_submodules('DrissionPage')
hiddenimports += collect_submodules('flask_sock')


a = Analysis(
    ['E:\\api_recoder\\main.py'],
    pathex=['E:\\api_recoder'],
    binaries=[],
    datas=[('E:\\api_recoder\\static', 'static')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='API_Recorder',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='API_Recorder',
)
