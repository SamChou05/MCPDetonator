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
  -e 'trace=%process,%file,%network,read,write,pread64,pwrite64,readv,writev,preadv,pwritev,preadv2,pwritev2,?close,?close_range,?dup,?dup2,?dup3,?fcntl,?fcntl64,?fstat,?fstat64,?getdents,?getdents64,?getxattr,?lgetxattr,?fgetxattr,?listxattr,?llistxattr,?flistxattr,?ftruncate,?fallocate,?copy_file_range,?sendfile,?sendfile64,?splice,?vmsplice,?tee,?fchmod,?fchmodat2,?fchown,?fsetxattr,?fremovexattr,?process_vm_readv,?process_vm_writev,?io_setup,?io_destroy,?io_submit,?io_cancel,?io_getevents,?io_pgetevents,?io_pgetevents_time64,?io_uring_setup,?io_uring_enter,?io_uring_register,?mmap,?mmap2,?bpf,?fsconfig,?fsmount,?fsopen,?fspick,?kill,?mount_setattr,?move_mount,?open_by_handle_at,?open_tree,?perf_event_open,?pidfd_send_signal,?ptrace,?setns,?tgkill,?tkill,?unshare,?userfaultfd' \
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
