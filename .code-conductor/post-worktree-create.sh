#!/usr/bin/env bash
# Share the main checkout's out-of-tree state with a new worktree.
#
# Run by code-conductor after creating a worktree, with cwd in the new
# worktree. CC_PARENT_PATH is the main checkout and CC_WORKTREE_PATH is the
# new worktree, both absolute.
#
# Links created (each one skipped with a warning if its source is missing or
# its link path is already taken):
#   .wiki                    -> main checkout's .wiki (git-excluded, so shared by link)
#   node_modules             -> main checkout's node_modules
#   <dir>/node_modules       -> main checkout's <dir>/node_modules, for every
#                               depth-1 directory that has one (e.g. frontend/)
#
# Always exits 0. A missing link is recoverable with an install, so the worktree
# create must not fail. Each link is handled on its own, so one failure does
# not stop the others (hence no `set -e`).

link_one() {
    # $1 = source (absolute path in the main checkout), $2 = link path, relative to the worktree
    local src="$1" dst="$2"
    if [ ! -d "$src" ]; then
        echo "[post-worktree-create] WARNING: ${src} not found; skipping ${dst} link." >&2
        return 0
    fi
    if [ ! -d "$(dirname "$dst")" ]; then
        echo "[post-worktree-create] WARNING: $(dirname "$dst") missing in worktree; skipping ${dst} link." >&2
        return 0
    fi
    if [ -e "$dst" ] || [ -L "$dst" ]; then
        echo "[post-worktree-create] ${dst} already exists - skipping link."
        return 0
    fi
    if ln -s "$src" "$dst"; then
        echo "[post-worktree-create] Symlinked ${dst} from ${src}."
    else
        echo "[post-worktree-create] WARNING: could not symlink ${dst}; continuing." >&2
    fi
    return 0
}

if [ -z "${CC_PARENT_PATH:-}" ] || [ -z "${CC_WORKTREE_PATH:-}" ]; then
    echo "[post-worktree-create] WARNING: CC_PARENT_PATH or CC_WORKTREE_PATH unset; skipping all links." >&2
    exit 0
fi

if ! cd "$CC_WORKTREE_PATH"; then
    echo "[post-worktree-create] WARNING: cannot enter ${CC_WORKTREE_PATH}; skipping all links." >&2
    exit 0
fi

link_one "$CC_PARENT_PATH/.wiki" .wiki
link_one "$CC_PARENT_PATH/node_modules" node_modules

# An unmatched glob stays literal, so the -d check also covers "no nested installs".
for nm in "$CC_PARENT_PATH"/*/node_modules; do
    [ -d "$nm" ] || continue
    dir=$(basename "$(dirname "$nm")")
    link_one "$nm" "$dir/node_modules"
done

exit 0
