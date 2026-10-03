"""Failure fences and broker ordering; no Docker, sudo, network or live deployment."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollback', Path(__file__).with_name('assistant-config-rollback.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
OLD, NEW, IMG = '8' * 40, '1' * 40, 'sha256:' + 'a' * 64


class Recipe(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.parent = Path(self.tmp.name)
        self.parent.chmod(0o700)
        self.state = self.parent / 'state.json'
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def broker(self, verb, *args):
        self.calls.append((verb, *args))
        return {
            'tag-release': f'BROKER_TAG_RELEASE_PASS service={r.SERVICE} {r.IMAGE}:{OLD}',
            'image-id': IMG,
            'tag-rotate': f'BROKER_TAG_ROTATE_PASS service={r.SERVICE} {r.IMAGE}:latest -> {r.IMAGE}:previous',
            'rollback': f'BROKER_ROLLBACK_PASS service={r.SERVICE}',
            'sync': 'BROKER_SYNC_PASS',
        }[verb]

    def prepare(self):
        r.prepare(self.state, OLD, NEW, IMG, self.broker, lambda: OLD)

    def test_prepare_then_restore_source_before_image(self):
        self.prepare()
        self.assertEqual(self.calls, [('tag-release',), ('image-id',), ('tag-rotate',)])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.calls.clear()
        r.rollback(self.state, NEW, self.broker, lambda: NEW)
        self.assertEqual(self.calls, [('sync', OLD), ('image-id',), ('rollback',)])
        self.assertEqual(r.read_state(self.state)['phase'], 'native_restored_requires_live_readback')

    def test_missing_broker_mapping_stops_before_rotate(self):
        def missing(verb, *args):
            self.calls.append(verb)
            raise RuntimeError('mapping missing')
        with self.assertRaises(RuntimeError):
            r.prepare(self.state, OLD, NEW, IMG, missing, lambda: OLD)
        self.assertEqual(self.calls, ['tag-release'])
        self.assertEqual(r.read_state(self.state)['phase'], 'preparing')

    def test_foreign_source_never_calls_broker(self):
        with self.assertRaises(RuntimeError):
            r.prepare(self.state, OLD, NEW, IMG, self.broker, lambda: NEW)
        self.assertEqual(self.calls, [])

    def test_wrong_image_refuses_rotate(self):
        def wrong(verb, *args):
            return 'sha256:' + 'b' * 64 if verb == 'image-id' else self.broker(verb, *args)
        with self.assertRaises(RuntimeError):
            r.prepare(self.state, OLD, NEW, IMG, wrong, lambda: OLD)
        self.assertNotIn(('tag-rotate',), self.calls)

    def test_unsafe_parent_before_any_broker_call(self):
        self.parent.chmod(0o755)
        with self.assertRaises(RuntimeError):
            self.prepare()
        self.assertEqual(self.calls, [])

    def test_symlink_parent_refused(self):
        link = self.parent / 'link'
        link.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            r.prepare(link / 'state', OLD, NEW, IMG, self.broker, lambda: OLD)
        self.assertEqual(self.calls, [])

    def test_failing_state_write_before_broker_mutation(self):
        with patch.object(r, 'save', side_effect=OSError('write refused')):
            with self.assertRaises(OSError):
                self.prepare()
        self.assertEqual(self.calls, [])

    def test_foreign_candidate_cannot_rollback(self):
        self.prepare()
        self.calls.clear()
        with self.assertRaises(RuntimeError):
            r.rollback(self.state, NEW, self.broker, lambda: OLD)
        self.assertEqual(self.calls, [])
        self.assertEqual(r.read_state(self.state)['phase'], 'applying')

    def test_failed_or_unknown_rollback_cannot_replay(self):
        self.prepare()
        self.calls.clear()
        def failed(verb, *args):
            if verb == 'rollback':
                raise RuntimeError('unknown outcome')
            return self.broker(verb, *args)
        with self.assertRaises(RuntimeError):
            r.rollback(self.state, NEW, failed, lambda: NEW)
        self.assertEqual(r.read_state(self.state)['phase'], 'applying')
        self.calls.clear()
        with self.assertRaises(RuntimeError):
            r.rollback(self.state, NEW, self.broker, lambda: NEW)
        self.assertEqual(self.calls, [])

    def test_state_hardlink_or_permissions_refused(self):
        self.prepare()
        os.link(self.state, self.parent / 'alias')
        with self.assertRaises(RuntimeError):
            r.read_state(self.state)
        (self.parent / 'alias').unlink()
        self.state.chmod(0o644)
        with self.assertRaises(RuntimeError):
            r.read_state(self.state)

    def test_malformed_state_refuses_without_broker(self):
        self.state.write_text(json.dumps({'phase': 'prepared', 'previous': 1}))
        self.state.chmod(0o600)
        with self.assertRaises(RuntimeError):
            r.rollback(self.state, NEW, self.broker, lambda: NEW)
        self.assertEqual(self.calls, [])

    def test_active_state_operation_refuses_second_invocation(self):
        lock = self.state.with_name(self.state.name + '.lock')
        fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            r.fcntl.flock(fd, r.fcntl.LOCK_EX | r.fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, 'already active'):
                self.prepare()
            self.assertEqual(self.calls, [])
        finally:
            os.close(fd)

    def test_native_errors_never_print_sentinel_output(self):
        result = type('Result', (), {'returncode': 1, 'stdout': 'SENTINEL_SECRET', 'stderr': 'SENTINEL_SECRET'})()
        output = io.StringIO()
        with patch.object(r.subprocess, 'run', return_value=result), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaisesRegex(RuntimeError, 'broker refused'):
                r.native('image-id')
        self.assertNotIn('SENTINEL_SECRET', output.getvalue())


if __name__ == '__main__':
    unittest.main()
