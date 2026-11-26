"""Migrate a single paired device and keep its service credential under user DPAPI."""
import base64
import ctypes as win
import json
import os
import re
import sys
from ctypes import wintypes as w
from pathlib import Path
from urllib.parse import urlsplit

IDENTITY = 'host-identity-v1.codex-switch.remote-chat'
DEVICE_ID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
CREDENTIAL = re.compile(r'csw-desktop-service-[0-9a-f]{64}')
MAX_CONFIG = 64 * 1024


class Blob(win.Structure):
    _fields_ = [('size', w.DWORD), ('data', win.POINTER(win.c_ubyte))]


class Credential(win.Structure):
    _fields_ = [('flags', w.DWORD), ('kind', w.DWORD), ('target', w.LPWSTR), ('comment', w.LPWSTR),
                ('last_written', w.FILETIME), ('size', w.DWORD), ('data', win.POINTER(win.c_ubyte)),
                ('persist', w.DWORD), ('attributes_count', w.DWORD), ('attributes', win.c_void_p),
                ('alias', w.LPWSTR), ('username', w.LPWSTR)]


def identity():
    api = win.WinDLL('advapi32', use_last_error=True)
    read, release = api.CredReadW, api.CredFree
    read.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, win.POINTER(win.POINTER(Credential))]
    release.argtypes = [win.c_void_p]
    ptr = win.POINTER(Credential)()
    if not read(IDENTITY, 1, 0, win.byref(ptr)):
        raise ValueError('HOST_IDENTITY_UNAVAILABLE')
    try:
        entry = ptr.contents
        value = win.string_at(entry.data, entry.size).decode('utf-16-le')
        if len(base64.b64decode(value, validate=True)) != 32:
            raise ValueError('HOST_IDENTITY_INVALID')
        return value
    finally:
        release(ptr)


def dpapi(data, protect):
    api = win.WinDLL('crypt32', use_last_error=True)
    free = win.WinDLL('kernel32').LocalFree
    free.argtypes = [win.c_void_p]
    free.restype = win.c_void_p
    array = (win.c_ubyte * len(data)).from_buffer_copy(data)
    source, result = Blob(len(array), array), Blob()
    call = api.CryptProtectData if protect else api.CryptUnprotectData
    call.argtypes = [win.POINTER(Blob), win.c_void_p, win.c_void_p, win.c_void_p,
                     win.c_void_p, w.DWORD, win.POINTER(Blob)]
    if not call(win.byref(source), None, None, None, None, 1, win.byref(result)):
        raise OSError('USER_VAULT_UNAVAILABLE')
    try:
        return win.string_at(result.data, result.size)
    finally:
        win.memset(result.data, 0, result.size)
        free(result.data)
        win.memset(array, 0, len(array))


def read(path):
    with path.open('rb') as handle:
        value = handle.read(MAX_CONFIG + 1)
    if len(value) > MAX_CONFIG:
        raise ValueError('DEVICE_CONFIGURATION_TOO_LARGE')
    return value


def validate(value, token_field):
    url = urlsplit(value['baseUrl'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('HTTPS_COORDINATOR_REQUIRED')
    if not DEVICE_ID.fullmatch(value['deviceId']) or len(base64.b64decode(value['identity'], validate=True)) != 32:
        raise ValueError('DEVICE_BINDING_INVALID')
    token = value[token_field]
    if not isinstance(token, str) or len(token) > 8192 or not token:
        raise ValueError('DEVICE_CREDENTIAL_INVALID')
    if token_field == 'credential' and not CREDENTIAL.fullmatch(token):
        raise ValueError('DEVICE_CREDENTIAL_INVALID')
    return value


def paired_desktop():
    profile = Path(os.environ['APPDATA']) / 'dev.codex.switch'
    settings = json.loads(read(profile / 'settings.json'))
    auth = json.loads(read(profile / 'cloud-auth.json'))
    device = json.loads(read(profile / 'installation.json'))
    if auth.get('deviceId') != device.get('deviceId') or not settings.get('cloudUserId'):
        raise ValueError('DEVICE_BINDING_INVALID')
    return validate({'baseUrl': settings['cloudBaseUrl'], 'deviceId': device['deviceId'],
                     'accessToken': auth['accessToken'], 'identity': identity()}, 'accessToken')


def main():
    command, target = sys.argv[1:]
    secret = Path(target)
    if command == 'pair':
        print(json.dumps(paired_desktop()))
    elif command == 'load':
        config = json.loads(dpapi(read(secret), False))
        print(json.dumps(validate(config, 'credential')))
    elif command == 'save':
        data = sys.stdin.buffer.read(MAX_CONFIG + 1)
        if len(data) > MAX_CONFIG:
            raise ValueError('DEVICE_CONFIGURATION_TOO_LARGE')
        validate(json.loads(data), 'credential')
        temp = secret.with_name(f'{secret.name}.{os.getpid()}.tmp')
        try:
            temp.write_bytes(dpapi(data, True))
            temp.replace(secret)
        finally:
            temp.unlink(missing_ok=True)
    else:
        raise ValueError('VAULT_OPERATION_INVALID')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError):
        # Identity seeds and access tokens are only sent through the inherited pipe.
        print('REMOTEAI_HANDOFF_VAULT_UNAVAILABLE', file=sys.stderr)
        sys.exit(1)
