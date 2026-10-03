#!/usr/bin/env python3
"""Preserve and restore an Assistant image AND Compose source via the fixed broker.

Prepared source only: the broker owner must first admit the Assistant IMAGE and
ROLLBACK_SERVICES entries. Never rebuild the baseline, evaluate env, or print
broker output/errors. A interrupted or failed mutation requires owner readback.
"""
import argparse
import fcntl
import functools
import json
import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path

BROKER = '/usr/local/sbin/arcanada-compose-broker'
SERVICE = 'arcanada-assistant'
IMAGE = 'arcanada-assistant-assistant'
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')


def native(action, *args):
    try:
        result = subprocess.run(
            ['/usr/bin/sudo', '-n', BROKER, SERVICE, action, *args],
            capture_output=True, text=True, timeout=150, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('broker outcome unknown; owner readback required') from None
    if result.returncode:
        raise RuntimeError('broker refused or failed; owner readback required')
    return result.stdout.strip()


def private_parent(path):
    parent = path.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError('state parent must be an owned real directory')
    if stat.S_IMODE(info.st_mode) != 0o700 or parent.resolve() != parent.absolute():
        raise RuntimeError('state parent must be private and contain no symlinks')


def save(path, data):
    private_parent(path)
    fd, name = tempfile.mkstemp(prefix='.rollback-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_state(path):
    private_parent(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise RuntimeError('state ownership or permissions refused')
        return json.load(stream)


def exclusive_state(operation):
    @functools.wraps(operation)
    def guarded(path, *args, **kwargs):
        private_parent(path)
        lock = path.with_name(path.name + '.lock')
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise RuntimeError('state lock ownership refused')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('state operation already active') from None
            return operation(path, *args, **kwargs)
        finally:
            os.close(fd)
    return guarded


def native_source():
    checkout = Path('/var/lib/arcanada-deploy/arcanada-assistant')
    for path in (checkout.parent, checkout, checkout / '.git'):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise RuntimeError('broker checkout ownership refused')
        if path.resolve() != path:
            raise RuntimeError('broker checkout symlink refused')
    try:
        result = subprocess.run(
            ['/usr/bin/git', '-c', 'safe.directory=' + str(checkout),
             '-C', str(checkout), 'rev-parse', 'HEAD'],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError('current source unmeasured') from None
    value = result.stdout.strip()
    if result.returncode or not SHA.fullmatch(value):
        raise RuntimeError('current source unmeasured')
    return value


@exclusive_state
def prepare(path, previous, candidate, image, call=native, read_source=native_source):
    if not SHA.fullmatch(previous) or not SHA.fullmatch(candidate) or previous == candidate:
        raise RuntimeError('source range refused')
    if not DIGEST.fullmatch(image):
        raise RuntimeError('image identity refused')
    private_parent(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    data = dict(phase='preparing', previous=previous, candidate=candidate, image=image)
    save(path, data)  # Durable fence BEFORE the first broker mutation.
    if read_source() != previous:
        raise RuntimeError('foreign baseline source; no image mutation authorized')
    tagged = call('tag-release')
    expected_tag = f'BROKER_TAG_RELEASE_PASS service={SERVICE} {IMAGE}:{previous}'
    if tagged != expected_tag or call('image-id') != image:
        raise RuntimeError('baseline source/image mismatch; no deploy authorized')
    rotated = call('tag-rotate')
    expected = f'BROKER_TAG_ROTATE_PASS service={SERVICE} {IMAGE}:latest -> {IMAGE}:previous'
    if rotated != expected:
        raise RuntimeError('baseline image preservation unmeasured')
    data['phase'] = 'prepared'
    save(path, data)


@exclusive_state
def rollback(path, candidate, call=native, read_source=native_source):
    data = read_state(path)
    if (not isinstance(data, dict) or not all(isinstance(data.get(k), str)
            for k in ['phase', 'candidate', 'previous', 'image'])
            or data.get('phase') != 'prepared' or data.get('candidate') != candidate
            or not SHA.fullmatch(data.get('previous', ''))
            or not SHA.fullmatch(candidate) or not DIGEST.fullmatch(data.get('image', ''))):
        raise RuntimeError('state or current source refused')
    data['phase'] = 'applying'
    save(path, data)  # Any later failure/timeout remains fenced from replay.
    if read_source() != candidate:
        raise RuntimeError('foreign or unchanged source; no rollback authorized')
    call('sync', data['previous'])  # Restore Compose and root-owned env BEFORE image recreation.
    if call('image-id') != data['image']:
        raise RuntimeError('preserved source-tag image mismatch')
    if call('rollback') != f'BROKER_ROLLBACK_PASS service={SERVICE}':
        raise RuntimeError('native rollback unmeasured')
    data['phase'] = 'native_restored_requires_live_readback'
    save(path, data)
    # Image tag restoration does not prove serving-image/route/DB health.
    # The existing owner must perform the documented minimum live readback.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'rollback'])
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--previous')
    parser.add_argument('--image')
    args = parser.parse_args()
    try:
        if args.action == 'prepare':
            prepare(args.state, args.previous or '', args.candidate, args.image or '')
        else:
            rollback(args.state, args.candidate)
    except (RuntimeError, ValueError, OSError):
        print('PAUSED_SAFE: state/broker refusal or unknown outcome; owner readback required')
        return 1
    print('SOURCE_RECIPE_APPLIED: live serving image/routes/health NOT_MEASURED')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
