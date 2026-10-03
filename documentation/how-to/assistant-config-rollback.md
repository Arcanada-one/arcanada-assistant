# Restore the Assistant Compose configuration and image

This is a prepared source recipe, not an admitted deployment or a live rollback
receipt. PR94 changes the HTTPS health default to `https://connector.arcanada.ai`;
the execution origin remains `http://connector.arcanada.one:3900`. The existing
18 unmeasured graph obligations remain open.

## Native prerequisites

The installed root broker currently has no Assistant entries in `IMAGE` or
`ROLLBACK_SERVICES`. Its existing owner must review, install through its own PR/CI,
and read back these exact service mappings before this recipe can run:

```bash
# Inside the existing IMAGE and ROLLBACK_SERVICES maps, respectively:
[arcanada-assistant]='arcanada-assistant-assistant'
[arcanada-assistant]='assistant'
```

These reuse the existing `tag-release`, `image-id`, `tag-rotate`, and `rollback`
verbs. Do not grant Docker membership, SETENV, a new account, or general root
commands. Confirm that the existing CI runner can read the root-owned public
broker checkout through the fixed read-only `git rev-parse HEAD` route. The helper
refuses symlinked or non-root-owned checkout paths.

Root must first admit the same PR94 resulting main and its normal CI. The main
workflow owns `deploy-arcanada-assistant`, never cancels main, and uses the
existing `arcana-prd-host` runner. No branch image or unmerged checkout may be
installed. A concurrent or foreign source is a refusal, not something to reset.

## Before the first sync or build

Independent readback measured the previous checkout as
`8159dfe516e2d406ec7ef2a1c4183a40fbedbfac` and both the running image and local
`:latest` as
`sha256:a95b16cc859d79be60fb35f8bfe16a0348711e47eef83f7d33e882894d7df709`.
Recheck those identities immediately before an admitted release; these dated
values are not authority to overwrite a later release. The root-owned source env
snapshot and checkout env had no health override. Do not edit either manually.

In the already admitted, exclusively owned main deployment job, create a fresh
0700 child of its `RUNNER_TEMP`; do not reuse another job's directory. Invoke:

```bash
python3 scripts/ci/assistant-config-rollback.py prepare \
  --state "$RUNNER_TEMP/assistant-rollback/state.json" \
  --previous 8159dfe516e2d406ec7ef2a1c4183a40fbedbfac \
  --candidate "$GITHUB_SHA" \
  --image sha256:a95b16cc859d79be60fb35f8bfe16a0348711e47eef83f7d33e882894d7df709
```

The helper fences a protected 0600 state before the first broker mutation, checks
the actual checkout, tags the baseline source, checks its exact image identity,
and preserves that image as `:previous`. Any refusal stops before sync/build.
This prepare step is **not wired into the live deploy job in this candidate**:
the external native mappings are still absent. The helper's adversarial fixtures
are wired into the existing CI lint job. Root/source review must bind prepare and
the following rollback step into the same exclusive release before activation.

## Roll back only this owned failed release

Retain the same private state and exclusivity until the live checks finish. If
that specific candidate fails its minimum checks, invoke from the admitted
candidate checkout:

```bash
python3 scripts/ci/assistant-config-rollback.py rollback \
  --state "$RUNNER_TEMP/assistant-rollback/state.json" \
  --candidate "$GITHUB_SHA"
```

The helper verifies that the actual root broker checkout still names this
candidate. It restores the previous Compose and root-managed env through `sync`,
checks the preserved baseline source-tag image, and calls the fixed `rollback`
verb to restore `:previous` and recreate only `assistant`. It never rebuilds the
baseline, stops Postgres/Redis, evaluates env, or emits native error bodies.
Restoring only the image would retain the new Compose health URL and is not a
configuration rollback.

An interrupted/failed mutation leaves the state fenced as `applying`; the helper
refuses replay. Do not retry an unknown outcome, retag another image, or use a
fresh state to evade the fence. The same existing owner must reconcile actual
source, image, serving PID and config before deciding a recovery step. A broker
success string does not establish a successful live rollback.

## Minimum readback

For the corrected candidate, prove the actual serving image/build and selected
health URL, HTTPS `.ai/health` 200 with the expected Connector build, unchanged
3900 execution-origin `/health` 200, and Assistant's real `modelConnector`,
Postgres and Redis dependency states. Send no `/execute` or provider request.
Keep HTTPS validation and auth untouched.

After rollback, prove the actual serving image is the preserved baseline image,
the root checkout is the previous source, and selected health URL is restored.
Check Assistant Postgres/Redis and the original execution-origin health. The
previous `.one` HTTPS health failure may return; report it as baseline degraded
health, never fake `ok`. Neither this rollback nor a health GET demonstrates
product acceptance, closes graph obligations, reverses DB migrations, or admits
knowledge/runtime FIT. Preserve both failed and restored receipts.
