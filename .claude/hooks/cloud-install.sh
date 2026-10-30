#!/bin/bash
# SessionStart hook: install project dependencies in Claude Code cloud sessions.
# Does nothing on your own machine (CLAUDE_CODE_REMOTE is only "true" in the cloud).
# Never fails the session: problems are reported to Claude as one line of context.
# Source: munashe-chivandire/claude-env (templates/.claude/hooks/cloud-install.sh)

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true

notes=()

install_node() {
  local dir="$1" stamp hashfiles cmd
  [ -f "$dir/package.json" ] || return 0
  if   [ -f "$dir/pnpm-lock.yaml" ];    then cmd="pnpm install --frozen-lockfile"; hashfiles="package.json pnpm-lock.yaml"
  elif [ -f "$dir/package-lock.json" ]; then cmd="npm ci --no-audit --no-fund";   hashfiles="package.json package-lock.json"
  elif [ -f "$dir/yarn.lock" ];         then cmd="yarn install --frozen-lockfile"; hashfiles="package.json yarn.lock"
  else                                      cmd="npm install --no-audit --no-fund --no-package-lock"; hashfiles="package.json"
  fi
  # Lockfiles written behind a mirror (e.g. registry.npmmirror.com) point at hosts the
  # cloud sandbox blocks; npm then retries forever. Fetch those from the default registry.
  if [ "${cmd%% *}" = npm ] && [ -f "$dir/package-lock.json" ]; then
    for host in $(grep -oE '"resolved": "https://[^/"]+' "$dir/package-lock.json" | cut -d/ -f3 | sort -u | grep -vx 'registry.npmjs.org'); do
      cmd="$cmd --replace-registry-host=$host"
    done
  fi
  stamp="$dir/node_modules/.claude-install.sha256"
  if (cd "$dir" && sha256sum --check --status node_modules/.claude-install.sha256 2>/dev/null); then
    return 0
  fi
  rm -f "$stamp"
  if (cd "$dir" && timeout "${CLAUDE_INSTALL_TIMEOUT:-480}" $cmd >/tmp/claude-hook-install.log 2>&1); then
    (cd "$dir" && sha256sum $hashfiles > node_modules/.claude-install.sha256) || true
    notes+=("node deps installed in ${dir} (${cmd%% *})")
  else
    notes+=("WARN '${cmd}' failed in ${dir}; see /tmp/claude-hook-install.log")
  fi
}

install_python() {
  local dir="$1"
  [ -f "$dir/pyproject.toml" ] || return 0
  if (cd "$dir" && timeout "${CLAUDE_INSTALL_TIMEOUT:-480}" uv sync --quiet >/tmp/claude-hook-uv.log 2>&1); then
    notes+=("python deps synced in ${dir} (uv)")
  else
    notes+=("WARN 'uv sync' failed in ${dir}; see /tmp/claude-hook-uv.log")
  fi
}

# Root package, plus any sub-directories passed as arguments (e.g. `cloud-install.sh agent`)
install_node .
install_python .
for d in "$@"; do
  install_node "$d"
  install_python "$d"
done

[ ${#notes[@]} -gt 0 ] && printf 'cloud-install: %s\n' "${notes[@]}"
exit 0
