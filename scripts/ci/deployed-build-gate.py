#!/usr/bin/env python3
"""A2-222 — prove the running container runs THIS commit's image, and fail when it runs another.

Replaces `arcanada-compose-broker arcanada-assistant freshness` as the deploy's post-`up` gate.
That verb asserts the container is younger than the broker's MAXAGE, which is a proxy for "the
deploy recreated the container" — and the proxy breaks in the direction that costs the most. Any
merge that changes no file the image is built from (docs, `.github/`, `ops/`) produces a
byte-identical image, compose correctly leaves the running container alone, and the gate fails a
deploy that landed. Measured on argana, same broker verb, 2026-09-23:

    arcanada-compose-broker: container argana-argana-1 is 2197s old (limit 600s)
    — deploy did not recreate it

Production was running exactly the code that commit contains. The red was false, and a red that
everyone knows to ignore is how the real one gets ignored too.

WHAT THIS CHECKS INSTEAD. `apps/assistant/src/health/build-fingerprint.ts` digests the file set
`apps/assistant/Dockerfile` copies into the image, computed inside the running container (the
image is single-stage and builds in place, so the sources are still there) and reported on
`GET /health` as `buildFingerprint`. This script computes the same digest over the deploy runner's
checkout and compares:

    equal      → the process serving traffic was built from this commit's image inputs. PASS,
                 whether or not anything was recreated.
    different  → the container is running some other build. FAIL — the failure the old check was
                 reaching for.
    unmeasured → the service could not name what it was built from (`digest: null`), or the field
                 is absent because the deployed image predates this gate. FAIL as `could not
                 prove`, never as a pass: an unproved claim is the third verdict, not a green one.

A 503 IS READ, NOT REFUSED. `/health` answers 503 whenever an owned dependency is down, and the
`verify` job already accepts that — an upstream outage is not a reason to call a release
undeployed. What this gate asks is a different question from whether the service is healthy, so it
reads the body at 200 and at 503 alike and only the DIGEST decides its verdict.

WHY PYTHON, WHEN THE SERVICE SIDE IS TYPESCRIPT. This job runs on `arcana-prd-host`, a production
host that carries python3 (the wait-for-/health step above parses its body with `python3 -c`
today) and no guaranteed node; adding `setup-node` would put a network download between a live
container and its verdict. The duplicated digest is not left on trust:
`apps/assistant/src/health/build-fingerprint.spec.ts` runs BOTH implementations over the same
trees and asserts the same digest, so they cannot drift apart in silence.

WHY THE EXPECTATION COMES FROM THE RUNNER'S OWN CHECKOUT. The runner supplies no content to the
deploy — the broker fetches and checks out the release itself. The checkout here only computes an
EXPECTATION, so the worst a compromised runner can do with it is weaken its own gate, which it
could equally do by not running this step at all.

NOT COVERED, stated rather than implied: `docker-compose.yml` and the root-owned deploy env file
decide the container rather than the image, are not copied into it, and so are not in this digest.
Container-level drift is `not_measured` by this gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DIGEST_ALGORITHM = "sha256"

# ---------------------------------------------------------------------------
# The digest. Held byte-identical to apps/assistant/src/health/build-fingerprint.ts by
# apps/assistant/src/health/build-fingerprint.spec.ts — change one side and that test goes red.
# ---------------------------------------------------------------------------

IMAGE_INPUTS: tuple[str, ...] = (
    "apps/assistant",
    "package.json",
    "packages/core",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "tsconfig.json",
)

IGNORED_DIR_NAMES = frozenset({"node_modules", "dist", "coverage", ".turbo", ".next", ".git", "__pycache__"})
IGNORED_SUFFIXES = (".tsbuildinfo", ".log")
IGNORED_FILE_NAMES = frozenset({".DS_Store"})

_CHUNK = 1024 * 1024


def _ignored(relative_posix: str) -> bool:
    parts = relative_posix.split("/")
    name = parts[-1]
    if name in IGNORED_FILE_NAMES or name.endswith(IGNORED_SUFFIXES):
        return True
    return any(part in IGNORED_DIR_NAMES for part in parts)


def _files_under(root: Path, entry: str, problems: list[str]) -> list[tuple[str, Path]]:
    target = root / entry
    if target.is_file():
        return [(entry, target)]
    if target.is_dir():
        found = [
            (rel, p)
            for p, rel in ((p, p.relative_to(root).as_posix()) for p in sorted(target.rglob("*")))
            if p.is_file() and not _ignored(rel)
        ]
        if not found:
            problems.append(f"declared image input '{entry}' is an empty directory")
        return found
    problems.append(f"declared image input '{entry}' is missing at {root}")
    return []


def fingerprint_of(root: str | Path) -> dict:
    """Digest IMAGE_INPUTS under `root`. Never raises: every failure is a `problems` entry and a
    `None` digest, because a gate that cannot prove its claim must say so."""
    base = Path(root).resolve()
    problems: list[str] = []
    entries: list[tuple[str, Path]] = []
    for entry in IMAGE_INPUTS:
        entries.extend(_files_under(base, entry, problems))

    def shape(digest: str | None) -> dict:
        return {
            "digest": digest,
            "files": len(entries),
            "root": str(base),
            "inputs": list(IMAGE_INPUTS),
            "problems": problems,
        }

    if problems:
        return shape(None)

    h = hashlib.new(DIGEST_ALGORITHM)
    for rel, path in sorted(entries):
        file_hash = hashlib.new(DIGEST_ALGORITHM)
        try:
            with path.open("rb") as fh:
                while chunk := fh.read(_CHUNK):
                    file_hash.update(chunk)
        except OSError as exc:
            problems.append(f"{rel} unreadable: {exc.__class__.__name__}: {exc}")
            return shape(None)
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(file_hash.hexdigest().encode("ascii"))
        h.update(b"\0")

    return shape(f"{DIGEST_ALGORITHM}:{h.hexdigest()}")


# ---------------------------------------------------------------------------
# The gate.
# ---------------------------------------------------------------------------

DEFAULT_HEALTH_URL = "http://127.0.0.1:3800/health"
HEALTH_FIELD = "buildFingerprint"
MAX_HEALTH_BYTES = 1024 * 1024


class GateFailure(Exception):
    """A verdict, not a crash: every exit through here prints one line and returns 1."""


def read_health(url: str, attempts: int, delay_s: float) -> dict:
    """Read /health, accepting 503 as an answer. The deploy's own wait-for-/health step has
    already accepted a 503 from a degraded upstream; refusing to read the body here would turn an
    unrelated outage into `the deploy did not land`, which is the class of false red this gate
    exists to remove."""
    last = ""
    for attempt in range(1, attempts + 1):
        try:
            try:
                with urllib.request.urlopen(url, timeout=5) as response:  # noqa: S310 — fixed loopback URL
                    body = response.read(MAX_HEALTH_BYTES + 1)
            except urllib.error.HTTPError as http_error:
                body = http_error.read(MAX_HEALTH_BYTES + 1)
            if len(body) > MAX_HEALTH_BYTES:
                raise GateFailure(f"{url} returned more than {MAX_HEALTH_BYTES} bytes")
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise GateFailure(f"{url} did not return a JSON object")
            return payload
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            last = f"{exc.__class__.__name__}: {exc}"
            if attempt < attempts:
                time.sleep(delay_s)
    raise GateFailure(f"{url} did not answer with usable JSON after {attempts} attempts — {last}")


def deployed_digest(payload: dict) -> str:
    """The digest the service reports, or a GateFailure naming exactly which way it was missing."""
    reported = payload.get(HEALTH_FIELD)
    if reported is None:
        raise GateFailure(
            f"/health carries no `{HEALTH_FIELD}`. Either the running container predates A2-222 "
            f"— which is itself a deploy that did not land this commit — or the field was removed. "
            f"NOT MEASURED is not a pass."
        )
    if not isinstance(reported, dict):
        raise GateFailure(f"/health `{HEALTH_FIELD}` is not an object")
    digest = reported.get("digest")
    if not digest:
        problems = "; ".join(str(p) for p in reported.get("problems") or ()) or "(no problems reported)"
        raise GateFailure(
            f"the running service could not name what it was built from: {problems}. NOT MEASURED "
            f"is not a pass — see apps/assistant/src/health/build-fingerprint.ts for when the "
            f"digest is null."
        )
    if not isinstance(digest, str):
        raise GateFailure(f"/health `{HEALTH_FIELD}.digest` is not a string")
    return digest


def run(url: str, root: Path, attempts: int, delay_s: float) -> int:
    expected = fingerprint_of(root)
    if not expected["digest"]:
        problems = "; ".join(expected["problems"]) or "(no problems reported)"
        print(f"deployed-build-gate: FAIL (could not prove) — no digest at the checkout {root}: {problems}")
        return 1

    try:
        running = deployed_digest(read_health(url, attempts, delay_s))
    except GateFailure as exc:
        print(f"deployed-build-gate: FAIL (could not prove) — {exc}")
        return 1

    if running != expected["digest"]:
        print(
            f"deployed-build-gate: FAIL — the container is NOT running this commit's image.\n"
            f"  this commit's {expected['files']} image inputs at {expected['root']}\n"
            f"    {expected['digest']}\n"
            f"  what the running service reports at {url}\n"
            f"    {running}\n"
            f"The deploy did not land: compose built nothing new, or the container was never "
            f"recreated onto the image this commit produces. Production is serving an older build. "
            f"Read the container logs on the host and re-run the deploy."
        )
        return 1

    print(
        f"deployed-build-gate: PASS — the running container was built from this commit's image "
        f"inputs ({expected['files']} files, {expected['digest']}). Recreation is not asserted, "
        f"and is not required: a commit that changes no image input is correctly deployed by "
        f"changing nothing."
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--health-url", default=DEFAULT_HEALTH_URL, help=f"default {DEFAULT_HEALTH_URL}")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument("--delay", type=float, default=3.0)
    parser.add_argument(
        "--print-fingerprint",
        action="store_true",
        help="compute and print the digest for --root and exit; used by the cross-language test",
    )
    args = parser.parse_args(argv)
    if args.print_fingerprint:
        result = fingerprint_of(args.root)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["digest"] else 1
    return run(args.health_url, Path(args.root), args.attempts, args.delay)


if __name__ == "__main__":
    raise SystemExit(main())
