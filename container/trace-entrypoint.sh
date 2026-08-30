#!/bin/sh
set -eu

evidence_directory="${FORGE_EVIDENCE_DIR:-/evidence/raw}"
target_home="${FORGE_TARGET_HOME:-/sandbox/home/forge}"
target_workspace="${FORGE_TARGET_WORKSPACE:-/sandbox/workspace}"
target_workspace_seed="${FORGE_TARGET_WORKSPACE_SEED:-}"
target_root="${FORGE_TARGET_ROOT:-/opt/target}"
target_cwd="${FORGE_TARGET_CWD:-${target_root}}"

install -d -m 0700 -o 0 -g 0 "${evidence_directory}"
if [ -n "${target_workspace_seed}" ]; then
  install -d -m 0777 -o 65534 -g 65534 "${target_workspace}"
  cp -a "${target_workspace_seed}/." "${target_workspace}/"
  chown -R 65534:65534 "${target_workspace}"
fi
cd "${target_cwd}"

exec strace \
  -ff \
  -ttt \
  -yy \
  -s 256 \
  -o "${evidence_directory}/strace" \
  -e trace=%process,%file,%network,read,write,pread64,pwrite64,readv,writev,preadv,pwritev,preadv2,pwritev2 \
  setpriv \
    --reuid=65534 \
    --regid=65534 \
    --clear-groups \
    --inh-caps=-all \
    --ambient-caps=-all \
    --bounding-set=-all \
    --no-new-privs \
    env -i \
      HOME="${target_home}" \
      PATH=/usr/local/bin:/usr/bin:/bin \
      NODE_ENV=production \
      FORGE_TARGET_ROOT="${target_root}" \
      FORGE_TARGET_WORKSPACE="${target_workspace}" \
      "$@"
