#!/usr/bin/env python3
"""A2-371 — go red when production has not been running main's image for longer than N.

THE SITUATION THIS CATCHES. On 2026-09-23 CI on main (f3ab0d7) failed in `audit` on a registry
`ECONNRESET`; `deploy` and `verify` `need` audit and were skipped; nobody re-ran the run, and main
stood undeployed for two days. Nothing was red by then: the failed run was one of many, and the
deploy gate (`deployed-build-gate.py`) only runs inside a deploy — a deploy that never starts never
fails its gate. This watchdog asks the same question from outside the pipeline, on a schedule.

It REUSES the deploy gate rather than re-implementing it: the digest (`fingerprint_of`), the
/health read that accepts a 503 (`read_health`) and the "could not name its build" refusals
(`deployed_digest`) are imported from `deployed-build-gate.py`, which in turn is held identical to
the container's own digest by `apps/assistant/src/health/build-fingerprint.spec.ts`.

WHAT "LAG" MEANS HERE. Not "time since main's last commit": most commits (docs, `.github/`) do not
change the image, and a deploy of them correctly changes nothing. Lag is the age of the OLDEST
image-input change on main that production is not running. The script walks main's image-input
commits newest-first, digests each one's tree, and stops at the first whose digest equals what
production reports; the commit after it is where the lag starts. Measuring from the newest change
instead would let a steady trickle of undeployed commits reset the clock forever.

VERDICTS (exit code):
    0  PASS     production runs main's image inputs, or the gap is younger than --max-lag
               (a deploy in flight is not an incident).
    1  FAIL     production has been behind main for longer than --max-lag, or production's build
               matches none of the last --max-walk image-input commits (behind by more than we
               can date — worse, not better), or the question could not be answered at all
               (no digest at the checkout, /health unreachable, no `buildFingerprint`). A
               watchdog that cannot see is not a watchdog that saw nothing.

NOT COVERED, stated rather than implied: the same as the deploy gate — `docker-compose.yml` and the
root-owned deploy env file are not image inputs, so container-level drift is not measured here.
The public URL goes through Cloudflare/traefik; an edge serving a stale cached /health would read
as lag. /health is not cached today (measured 2026-09-25, `timestamp` changes per request).
"""

from __future__ import annotations

import argparse
import importlib.util
import io
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_HEALTH_URL = "https://assistant.arcanada.ai/health"
# Cloudflare answers urllib's default `Python-urllib/3.x` agent with 403 `error code: 1010` (measured
# 2026-09-25), which the gate would report as "no usable JSON". The deploy gate reads loopback and
# never meets the edge; this watchdog does, so it names itself.
USER_AGENT = "arcanada-assistant-deploy-lag-watchdog/1.0 (+A2-371)"


def _load_gate():
    spec = importlib.util.spec_from_file_location("deployed_build_gate", HERE / "deployed-build-gate.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


gate = _load_gate()


def _git(root: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True).stdout


def input_commits(root: Path, ref: str, limit: int) -> list[tuple[str, int]]:
    """(sha, committer-epoch) of commits on `ref` that touch an image input, newest first."""
    out = _git(root, "log", f"-{limit}", "--format=%H %ct", ref, "--", *gate.IMAGE_INPUTS).decode()
    return [(sha, int(ts)) for sha, ts in (line.split() for line in out.splitlines() if line.strip())]


def digest_at(root: Path, sha: str) -> str | None:
    """The deploy gate's digest over the tree of `sha`, extracted from git — no checkout moved."""
    present = [p for p in gate.IMAGE_INPUTS if _git(root, "ls-tree", "--name-only", sha, "--", p).strip()]
    with tempfile.TemporaryDirectory(prefix="deploy-lag-") as scratch:
        if present:
            archive = _git(root, "archive", "--format=tar", sha, "--", *present)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                try:
                    tar.extractall(scratch, filter="data")
                except TypeError:  # python < 3.11.4 has no extraction filters
                    tar.extractall(scratch)  # noqa: S202 — our own git archive
        return gate.fingerprint_of(scratch)["digest"]


def run(root: Path, ref: str, url: str, max_lag_s: int, max_walk: int, attempts: int, delay_s: float,
        now: float | None = None) -> int:
    now = time.time() if now is None else now
    expected = gate.fingerprint_of(root)["digest"]
    if not expected:
        print(f"deploy-lag-watchdog: FAIL (could not prove) — no digest at the checkout {root}")
        return 1
    try:
        running = gate.deployed_digest(gate.read_health(url, attempts, delay_s))
    except gate.GateFailure as exc:
        print(f"deploy-lag-watchdog: FAIL (could not prove) — {exc}")
        return 1

    if running == expected:
        print(f"deploy-lag-watchdog: PASS — production runs main's image inputs ({expected}).")
        return 0

    commits = input_commits(root, ref, max_walk)
    oldest_undeployed: tuple[str, int] | None = None
    for sha, ts in commits:
        if digest_at(root, sha) == running:
            break
        oldest_undeployed = (sha, ts)
    else:
        print(
            f"deploy-lag-watchdog: FAIL — production reports {running}, which matches none of the last "
            f"{len(commits)} image-input commits on {ref}. It is behind by more than this watchdog "
            f"can date, or it runs a build that was never on {ref}."
        )
        return 1

    if oldest_undeployed is None:
        # Production matches the newest image-input commit yet differs from the checkout: the
        # checkout carries uncommitted changes. Not a production lag; refuse to guess.
        print(f"deploy-lag-watchdog: FAIL (could not prove) — checkout {root} differs from {ref}'s newest image-input commit")
        return 1

    sha, ts = oldest_undeployed
    lag = int(now - ts)
    detail = (
        f"production reports {running}; {ref} expects {expected}. Oldest undeployed image-input "
        f"commit {sha[:12]} landed {lag}s ago (limit {max_lag_s}s)."
    )
    if lag <= max_lag_s:
        print(f"deploy-lag-watchdog: PASS (deploy pending) — {detail}")
        return 0
    print(
        f"deploy-lag-watchdog: FAIL — main is NOT deployed. {detail}\n"
        f"Find the CI run of {ref} head and read its `deploy` job: `skipped` means a gate upstream "
        f"failed. Re-run it (`gh run rerun <run-id> --failed`); if the failure was real, fix it."
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--health-url", default=DEFAULT_HEALTH_URL)
    parser.add_argument("--root", default=str(HERE.parents[1]))
    parser.add_argument("--ref", default="HEAD", help="the branch whose deployment is watched (default HEAD)")
    parser.add_argument("--max-lag", type=int, default=7200, help="seconds an undeployed change may wait (default 7200)")
    parser.add_argument("--max-walk", type=int, default=50, help="image-input commits to search back (default 50)")
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument("--delay", type=float, default=3.0)
    args = parser.parse_args(argv)
    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", USER_AGENT)]
    urllib.request.install_opener(opener)
    return run(Path(args.root), args.ref, args.health_url, args.max_lag, args.max_walk, args.attempts, args.delay)


if __name__ == "__main__":
    sys.exit(main())
