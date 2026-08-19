#!/usr/bin/env bash
# Commit one run summary to the `run-data` branch (spec §7/§8: main stays human).
#
#   .github/scripts/publish-run-data.sh <ledger-dir> <relative-path> <commit-message>
#
# The ledger is normally checked out by actions/checkout with `ref: run-data`, which also sets
# up an authenticated remote. The first ever run has no such branch, so this creates it as an
# orphan and pushes with GITHUB_TOKEN. It never force-pushes: the ledger *is* the history.
set -euo pipefail

DIR="${1:?ledger directory}"
REL_PATH="${2:?path within the ledger}"
MESSAGE="${3:?commit message}"

cd "$DIR"

if [[ ! -d .git ]]; then
  echo "run-data branch does not exist yet — creating it"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN is required to create the run-data branch}"
  git init --quiet --initial-branch=run-data
  # x-access-token is how a workflow token authenticates over https.
  git remote add origin \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY:?}.git"
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add "$REL_PATH"
if git diff --cached --quiet; then
  echo "nothing to commit (the summary is unchanged)"
  exit 0
fi

git commit --quiet --message "$MESSAGE"

# The regression and load workflows have separate concurrency groups, so two runs can finish
# minutes apart and race here. Rebase and retry rather than losing a summary to a rejected
# push — each run writes its own file, so a rebase never conflicts.
for attempt in 1 2 3; do
  if git push --quiet origin HEAD:run-data 2>/dev/null; then
    echo "published $REL_PATH to run-data"
    exit 0
  fi
  echo "push rejected (attempt $attempt) — rebasing onto the latest run-data"
  if git fetch --quiet origin run-data; then
    git rebase --quiet FETCH_HEAD || {
      git rebase --abort || true
      echo "could not rebase onto run-data; leaving the summary uncommitted upstream" >&2
      exit 1
    }
  fi
  sleep $(( attempt * 5 ))
done

echo "could not publish $REL_PATH after 3 attempts" >&2
exit 1
