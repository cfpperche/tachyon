/*
 * SDD 368 — minimal read-only same-UID worktree-binding audit helper (spike prototype).
 *
 * Usage: process-audit-helper <canonical-absolute-directory>
 *
 * Scans only processes whose real UID equals the invoker's real UID. Inspects
 * /proc/<pid>/{cwd,root,fd/<n>} via readlink only. Never signals, never ptrace-
 * attaches, never writes procfs, never mutates the target directory, and never
 * prints unrelated process path strings.
 *
 * States (accepted predicate):
 *   empty     — complete no-hit scan with no incomplete evidence
 *   survivors — one or more matching bindings and no incomplete evidence
 *   unknown   — any EACCES, instability, truncation, malformed link, identity
 *               drift, or capability-loss evidence (takes precedence)
 *
 * Exit codes: 0 empty | 1 survivors | 2 unknown | 3 usage/internal error
 *
 * File capability intended for production-adjacent use (not installed by this
 * spike unless noninteractive setcap is already available):
 *   CAP_SYS_PTRACE (effective+permitted) so Yama/nondumpable same-UID targets
 *   become readable. Without it, same-UID EACCES correctly yields unknown.
 */

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/capability.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define LINK_BUF 8192
#define MAX_UNKNOWN_REPORT 64
#define MAX_MATCH_REPORT 256
#define MAX_FIXED_POINT 8
#define MAX_PIDS 65536

/* Linux CAP_SYS_PTRACE = 19 */
#ifndef CAP_SYS_PTRACE
#define CAP_SYS_PTRACE 19
#endif

enum state {
  ST_EMPTY = 0,
  ST_SURVIVORS = 1,
  ST_UNKNOWN = 2,
  ST_ERROR = 3,
};

enum link_kind {
  KIND_CWD = 0,
  KIND_ROOT = 1,
  KIND_FD = 2,
};

struct match_ev {
  pid_t pid;
  unsigned long long starttime;
  enum link_kind kind;
  int fd; /* only for KIND_FD; else -1 */
};

struct unknown_ev {
  pid_t pid; /* 0 if not process-specific */
  const char *reason;
  enum link_kind kind;
  int fd;
  bool has_kind;
  bool has_fd;
};

struct audit {
  uid_t self_ruid;
  /* Caller-supplied path; after pin, must equal realpath() byte-for-byte. */
  const char *target;
  size_t target_len;
  /* O_PATH|O_DIRECTORY pin of the target inode for TOCTOU revalidation. */
  int target_fd;
  dev_t target_dev;
  ino_t target_ino;
  bool has_ptrace_cap;
  bool saw_cap_loss;
  bool saw_instability;
  unsigned match_count;
  unsigned unknown_count;
  unsigned match_report_n;
  unsigned unknown_report_n;
  struct match_ev matches[MAX_MATCH_REPORT];
  struct unknown_ev unknowns[MAX_UNKNOWN_REPORT];
};

static const char *kind_name(enum link_kind k) {
  switch (k) {
  case KIND_CWD: return "cwd";
  case KIND_ROOT: return "root";
  case KIND_FD: return "fd";
  }
  return "?";
}

static void add_unknown(struct audit *a, pid_t pid, const char *reason,
                        bool has_kind, enum link_kind kind, bool has_fd,
                        int fd) {
  a->unknown_count++;
  if (a->unknown_report_n >= MAX_UNKNOWN_REPORT)
    return;
  struct unknown_ev *u = &a->unknowns[a->unknown_report_n++];
  u->pid = pid;
  u->reason = reason;
  u->has_kind = has_kind;
  u->kind = kind;
  u->has_fd = has_fd;
  u->fd = fd;
}

/* Always visible in the report buffer (clobbers last slot if full). Used for
 * target pin/revalidation failures so TOCTOU drift is never silent. */
static void add_unknown_critical(struct audit *a, const char *reason) {
  a->unknown_count++;
  unsigned idx;
  if (a->unknown_report_n < MAX_UNKNOWN_REPORT)
    idx = a->unknown_report_n++;
  else
    idx = MAX_UNKNOWN_REPORT - 1;
  struct unknown_ev *u = &a->unknowns[idx];
  u->pid = 0;
  u->reason = reason;
  u->has_kind = false;
  u->kind = KIND_CWD;
  u->has_fd = false;
  u->fd = -1;
}

static void add_match(struct audit *a, pid_t pid, unsigned long long st,
                      enum link_kind kind, int fd) {
  a->match_count++;
  if (a->match_report_n >= MAX_MATCH_REPORT)
    return;
  struct match_ev *m = &a->matches[a->match_report_n++];
  m->pid = pid;
  m->starttime = st;
  m->kind = kind;
  m->fd = fd;
}

static bool cap_sys_ptrace_effective(void) {
  struct __user_cap_header_struct hdr = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct data[2];
  memset(data, 0, sizeof(data));
  if (syscall(SYS_capget, &hdr, data) != 0)
    return false;
  /* capability bit index: CAP_SYS_PTRACE = 19 → data[0].effective bit 19 */
  uint32_t idx = (uint32_t)CAP_SYS_PTRACE;
  uint32_t word = idx / 32u;
  uint32_t bit = idx % 32u;
  if (word > 1u)
    return false;
  return (data[word].effective & (1u << bit)) != 0;
}

/* Strip a single trailing " (deleted)" display suffix from a proc symlink. */
static void strip_deleted_suffix(char *s) {
  static const char suf[] = " (deleted)";
  size_t n = strlen(s);
  size_t sn = sizeof(suf) - 1;
  if (n >= sn && memcmp(s + (n - sn), suf, sn) == 0)
    s[n - sn] = '\0';
}

/* True when s ends with the procfs " (deleted)" display suffix (not stripped). */
static bool has_deleted_suffix(const char *s) {
  static const char suf[] = " (deleted)";
  size_t n = strlen(s);
  size_t sn = sizeof(suf) - 1;
  return n >= sn && memcmp(s + (n - sn), suf, sn) == 0;
}

/*
 * Revalidate pinned target identity against live realpath/stat and the
 * O_PATH descriptor via /proc/self/fd. Fail closed: any mismatch or missing
 * path returns false and records an unknown reason (never under-report).
 */
static bool revalidate_target(struct audit *a) {
  char resolved[PATH_MAX];
  if (!realpath(a->target, resolved)) {
    add_unknown_critical(a, "target_missing");
    return false;
  }
  if (strcmp(resolved, a->target) != 0) {
    add_unknown_critical(a, "target_path_drift");
    return false;
  }

  struct stat st_path;
  if (stat(a->target, &st_path) != 0) {
    add_unknown_critical(a, "target_missing");
    return false;
  }
  if (!S_ISDIR(st_path.st_mode)) {
    add_unknown_critical(a, "target_not_dir");
    return false;
  }
  if (st_path.st_dev != a->target_dev || st_path.st_ino != a->target_ino) {
    add_unknown_critical(a, "target_identity_drift");
    return false;
  }

  struct stat st_fd;
  if (fstat(a->target_fd, &st_fd) != 0) {
    add_unknown_critical(a, "target_fd_error");
    return false;
  }
  if (!S_ISDIR(st_fd.st_mode) || st_fd.st_dev != a->target_dev ||
      st_fd.st_ino != a->target_ino) {
    add_unknown_critical(a, "target_identity_drift");
    return false;
  }

  char fdlink_path[64];
  snprintf(fdlink_path, sizeof(fdlink_path), "/proc/self/fd/%d", a->target_fd);
  char linkbuf[LINK_BUF];
  ssize_t n = readlink(fdlink_path, linkbuf, sizeof(linkbuf));
  if (n < 0) {
    add_unknown_critical(a, "target_fd_error");
    return false;
  }
  if ((size_t)n >= sizeof(linkbuf)) {
    add_unknown_critical(a, "target_fd_error");
    return false;
  }
  linkbuf[n] = '\0';
  /* Unlinked/renamed O_PATH targets surface as "... (deleted)" — fail closed. */
  if (has_deleted_suffix(linkbuf)) {
    add_unknown_critical(a, "target_deleted");
    return false;
  }
  if (strcmp(linkbuf, a->target) != 0) {
    add_unknown_critical(a, "target_path_drift");
    return false;
  }
  return true;
}

/*
 * True when path is the target directory or a descendant. Target is assumed
 * canonical absolute (no trailing slash except for root "/").
 */
static bool path_binds(const char *path, const char *target, size_t tlen) {
  size_t plen = strlen(path);
  if (tlen == 1 && target[0] == '/') {
    /* Everything is under root; treat as bind only for exact "/" root mount
     * style — still a valid binding to "/". */
    return plen >= 1 && path[0] == '/';
  }
  if (plen < tlen)
    return false;
  if (memcmp(path, target, tlen) != 0)
    return false;
  if (plen == tlen)
    return true;
  return path[tlen] == '/';
}

static bool is_all_digits(const char *s) {
  if (!s || !*s)
    return false;
  for (const char *p = s; *p; p++) {
    if (*p < '0' || *p > '9')
      return false;
  }
  return true;
}

/* Read real UID from /proc/<pid>/status. Returns false on failure. */
static bool read_real_uid(pid_t pid, uid_t *out) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/status", (int)pid);
  FILE *f = fopen(path, "r");
  if (!f)
    return false;
  char line[256];
  bool ok = false;
  while (fgets(line, sizeof(line), f)) {
    if (strncmp(line, "Uid:", 4) == 0) {
      unsigned int ruid = 0;
      if (sscanf(line + 4, "%u", &ruid) == 1) {
        *out = (uid_t)ruid;
        ok = true;
      }
      break;
    }
  }
  fclose(f);
  return ok;
}

/*
 * Parse starttime (field 22) from /proc/<pid>/stat.
 * Format: pid (comm) state ppid ... with comm possibly containing spaces/parens.
 */
static bool read_starttime(pid_t pid, unsigned long long *out) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
  FILE *f = fopen(path, "r");
  if (!f)
    return false;
  char buf[4096];
  size_t n = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  if (n == 0)
    return false;
  buf[n] = '\0';
  char *rparen = strrchr(buf, ')');
  if (!rparen || rparen[1] != ' ')
    return false;
  /* Fields after comm: 3=state ... field 22 is starttime = index 20 after state. */
  char *p = rparen + 2;
  int field = 3;
  unsigned long long val = 0;
  while (*p && field <= 22) {
    while (*p == ' ')
      p++;
    if (!*p)
      break;
    char *end = p;
    while (*end && *end != ' ')
      end++;
    if (field == 22) {
      errno = 0;
      val = strtoull(p, NULL, 10);
      if (errno != 0)
        return false;
      *out = val;
      return true;
    }
    p = end;
    field++;
  }
  return false;
}

enum read_result {
  RR_OK = 0,
  RR_ENOENT,    /* process/fd vanished */
  RR_EACCES,
  RR_TRUNC,
  RR_MALFORMED,
  RR_OTHER,
};

static enum read_result read_proc_link(const char *path, char *out, size_t outsz) {
  ssize_t n = readlink(path, out, outsz);
  if (n < 0) {
    if (errno == ENOENT || errno == ESRCH)
      return RR_ENOENT;
    if (errno == EACCES || errno == EPERM)
      return RR_EACCES;
    return RR_OTHER;
  }
  if ((size_t)n >= outsz)
    return RR_TRUNC;
  out[n] = '\0';
  /* Proc symlinks for cwd/root/fd should be absolute or special pseudo targets
   * (pipe:[...], socket:[...], anon_inode:...). Relative or empty is malformed
   * for binding purposes. */
  if (n == 0)
    return RR_MALFORMED;
  return RR_OK;
}

static void consider_link(struct audit *a, pid_t pid, unsigned long long st,
                          enum link_kind kind, int fd, const char *linkpath) {
  char target_buf[LINK_BUF];
  enum read_result rr = read_proc_link(linkpath, target_buf, sizeof(target_buf));
  switch (rr) {
  case RR_OK:
    break;
  case RR_ENOENT:
    /* Vanishing process/FD is handled by fixed-point rescan at outer level
     * for whole-process ENOENT; for individual FDs, skip quietly. */
    return;
  case RR_EACCES:
    add_unknown(a, pid, "eaccess", true, kind, kind == KIND_FD, fd);
    return;
  case RR_TRUNC:
    add_unknown(a, pid, "truncation", true, kind, kind == KIND_FD, fd);
    return;
  case RR_MALFORMED:
    add_unknown(a, pid, "malformed_link", true, kind, kind == KIND_FD, fd);
    return;
  case RR_OTHER:
    add_unknown(a, pid, "read_error", true, kind, kind == KIND_FD, fd);
    return;
  }

  strip_deleted_suffix(target_buf);

  /* Non-path pseudo targets cannot bind a directory. */
  if (target_buf[0] != '/')
    return;

  if (path_binds(target_buf, a->target, a->target_len))
    add_match(a, pid, st, kind, kind == KIND_FD ? fd : -1);
}

static bool scan_one_pid(struct audit *a, pid_t pid, bool *vanished) {
  *vanished = false;

  uid_t ruid = 0;
  if (!read_real_uid(pid, &ruid)) {
    if (errno == ENOENT || access(("/proc"), R_OK) == 0) {
      /* status gone => process vanished */
      char p[64];
      snprintf(p, sizeof(p), "/proc/%d", (int)pid);
      if (access(p, F_OK) != 0) {
        *vanished = true;
        return true;
      }
    }
    add_unknown(a, pid, "status_unreadable", false, KIND_CWD, false, -1);
    return true;
  }
  if (ruid != a->self_ruid)
    return true; /* out of domain — silent skip */

  unsigned long long st1 = 0, st2 = 0;
  if (!read_starttime(pid, &st1)) {
    char p[64];
    snprintf(p, sizeof(p), "/proc/%d", (int)pid);
    if (access(p, F_OK) != 0) {
      *vanished = true;
      return true;
    }
    add_unknown(a, pid, "stat_unreadable", false, KIND_CWD, false, -1);
    return true;
  }

  char linkpath[128];
  snprintf(linkpath, sizeof(linkpath), "/proc/%d/cwd", (int)pid);
  consider_link(a, pid, st1, KIND_CWD, -1, linkpath);

  snprintf(linkpath, sizeof(linkpath), "/proc/%d/root", (int)pid);
  consider_link(a, pid, st1, KIND_ROOT, -1, linkpath);

  char fddir[64];
  snprintf(fddir, sizeof(fddir), "/proc/%d/fd", (int)pid);
  DIR *d = opendir(fddir);
  if (!d) {
    if (errno == ENOENT || errno == ESRCH) {
      *vanished = true;
      return true;
    }
    if (errno == EACCES || errno == EPERM) {
      add_unknown(a, pid, "eaccess", true, KIND_FD, false, -1);
      /* still recheck identity below */
    } else {
      add_unknown(a, pid, "fd_dir_error", true, KIND_FD, false, -1);
    }
  } else {
    pid_t self_pid = getpid();
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
      if (!is_all_digits(ent->d_name))
        continue;
      errno = 0;
      long fdn = strtol(ent->d_name, NULL, 10);
      if (errno != 0 || fdn < 0 || fdn > INT_MAX)
        continue;
      /* Exclude our own O_PATH target pin — it is not a binding under audit. */
      if (pid == self_pid && (int)fdn == a->target_fd)
        continue;
      snprintf(linkpath, sizeof(linkpath), "/proc/%d/fd/%ld", (int)pid, fdn);
      consider_link(a, pid, st1, KIND_FD, (int)fdn, linkpath);
    }
    closedir(d);
  }

  if (!read_starttime(pid, &st2)) {
    char p[64];
    snprintf(p, sizeof(p), "/proc/%d", (int)pid);
    if (access(p, F_OK) != 0) {
      *vanished = true;
      return true;
    }
    add_unknown(a, pid, "stat_unreadable", false, KIND_CWD, false, -1);
    return true;
  }
  if (st1 != st2) {
    add_unknown(a, pid, "identity_drift", false, KIND_CWD, false, -1);
  }
  return true;
}

static int collect_pids(pid_t *pids, int maxn) {
  DIR *d = opendir("/proc");
  if (!d)
    return -1;
  int n = 0;
  struct dirent *ent;
  while ((ent = readdir(d)) != NULL) {
    if (!is_all_digits(ent->d_name))
      continue;
    if (n >= maxn) {
      closedir(d);
      return -2; /* truncation of pid enumeration */
    }
    errno = 0;
    long v = strtol(ent->d_name, NULL, 10);
    if (errno != 0 || v <= 0 || v > INT_MAX)
      continue;
    pids[n++] = (pid_t)v;
  }
  closedir(d);
  return n;
}

static enum state run_audit(struct audit *a) {
  pid_t *pids = calloc((size_t)MAX_PIDS, sizeof(pid_t));
  if (!pids) {
    fprintf(stderr, "error=oom\n");
    return ST_ERROR;
  }

  for (int iter = 0; iter < MAX_FIXED_POINT; iter++) {
    /* Reset per-pass counters but keep cap_loss sticky across passes. */
    a->match_count = 0;
    a->unknown_count = 0;
    a->match_report_n = 0;
    a->unknown_report_n = 0;
    a->saw_instability = false;

    /* F2: sticky capability_loss is re-counted/reported every pass so a final
     * stable pass can never print state=unknown with unknown_count=0/no reason
     * after an earlier-pass loss observation. */
    if (a->has_ptrace_cap && !cap_sys_ptrace_effective())
      a->saw_cap_loss = true;
    if (a->saw_cap_loss)
      add_unknown(a, 0, "capability_loss", false, KIND_CWD, false, -1);

    /* F1: pre-pass target identity revalidation (realpath + path stat +
     * O_PATH fstat + /proc/self/fd link). */
    if (!revalidate_target(a)) {
      free(pids);
      return ST_UNKNOWN;
    }

    int np = collect_pids(pids, MAX_PIDS);
    if (np == -1) {
      add_unknown(a, 0, "proc_unreadable", false, KIND_CWD, false, -1);
      free(pids);
      return ST_UNKNOWN;
    }
    if (np == -2) {
      add_unknown(a, 0, "pid_enum_truncated", false, KIND_CWD, false, -1);
      free(pids);
      return ST_UNKNOWN;
    }

    bool any_vanished = false;
    for (int i = 0; i < np; i++) {
      bool vanished = false;
      scan_one_pid(a, pids[i], &vanished);
      if (vanished)
        any_vanished = true;
    }

    /* F1: post-pass revalidation — rename/replacement/deletion mid-scan fails
     * closed to unknown (never under-report as empty). */
    if (!revalidate_target(a)) {
      free(pids);
      return ST_UNKNOWN;
    }

    if (!any_vanished) {
      free(pids);
      if (a->saw_cap_loss || a->unknown_count > 0)
        return ST_UNKNOWN;
      if (a->match_count > 0)
        return ST_SURVIVORS;
      return ST_EMPTY;
    }
    a->saw_instability = true;
    /* rescan to fixed point */
  }

  free(pids);
  add_unknown(a, 0, "instability_fixed_point", false, KIND_CWD, false, -1);
  return ST_UNKNOWN;
}

static int usage(const char *argv0) {
  fprintf(stderr,
          "usage: %s <canonical-absolute-directory>\n"
          "read-only same-UID worktree binding audit (cwd/root/fd)\n"
          "exit: 0 empty | 1 survivors | 2 unknown | 3 error\n",
          argv0);
  return ST_ERROR;
}

int main(int argc, char **argv) {
  if (argc != 2)
    return usage(argv[0]);

  const char *target = argv[1];
  if (target[0] != '/') {
    fprintf(stderr, "error=target_not_absolute\n");
    return ST_ERROR;
  }
  /* Syntactic pre-checks: absolute, no relative segments, no trailing slash. */
  if (strstr(target, "/./") != NULL || strstr(target, "/../") != NULL ||
      strcmp(target, "/.") == 0 || strcmp(target, "/..") == 0) {
    fprintf(stderr, "error=target_not_canonical\n");
    return ST_ERROR;
  }
  size_t tlen = strlen(target);
  if (tlen > 1 && target[tlen - 1] == '/') {
    fprintf(stderr, "error=target_trailing_slash\n");
    return ST_ERROR;
  }
  if (tlen >= PATH_MAX) {
    fprintf(stderr, "error=target_too_long\n");
    return ST_ERROR;
  }

  /*
   * F1 pin: independent realpath must equal the caller string byte-for-byte
   * (rejects symlink aliases and non-canonical inputs). Then open
   * O_PATH|O_DIRECTORY|O_CLOEXEC and pin st_dev+st_ino for every-pass
   * revalidation.
   */
  char resolved[PATH_MAX];
  if (!realpath(target, resolved)) {
    fprintf(stderr, "error=target_unresolvable\n");
    return ST_ERROR;
  }
  if (strcmp(resolved, target) != 0) {
    /* Symlink component or other non-canonical alias — refuse, do not scan. */
    fprintf(stderr, "error=target_not_canonical\n");
    return ST_ERROR;
  }

  int tfd = open(target, O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (tfd < 0) {
    fprintf(stderr, "error=target_open_failed\n");
    return ST_ERROR;
  }
  struct stat st;
  if (fstat(tfd, &st) != 0 || !S_ISDIR(st.st_mode)) {
    close(tfd);
    fprintf(stderr, "error=target_open_failed\n");
    return ST_ERROR;
  }

  struct audit a;
  memset(&a, 0, sizeof(a));
  a.self_ruid = getuid(); /* real UID */
  a.target = target;
  a.target_len = tlen;
  a.target_fd = tfd;
  a.target_dev = st.st_dev;
  a.target_ino = st.st_ino;
  a.has_ptrace_cap = cap_sys_ptrace_effective();

  /* Initial pin check before any pass (same contract as pre/post revalidate). */
  if (!revalidate_target(&a)) {
    /* Emit machine-readable unknown rather than under-reporting. */
    printf("state=unknown\n");
    printf("self_ruid=%u\n", (unsigned)a.self_ruid);
    printf("target=%s\n", a.target);
    printf("cap_sys_ptrace=%s\n", a.has_ptrace_cap ? "yes" : "no");
    printf("match_count=0\n");
    printf("unknown_count=%u\n", a.unknown_count);
    for (unsigned i = 0; i < a.unknown_report_n; i++) {
      const struct unknown_ev *u = &a.unknowns[i];
      printf("unknown reason=%s\n", u->reason);
    }
    close(tfd);
    return ST_UNKNOWN;
  }

  enum state st_res = run_audit(&a);
  if (st_res == ST_ERROR) {
    close(tfd);
    return ST_ERROR;
  }

  const char *state_s = st_res == ST_EMPTY
                            ? "empty"
                            : st_res == ST_SURVIVORS ? "survivors" : "unknown";

  /* Machine-readable stable output. No unrelated path strings. */
  printf("state=%s\n", state_s);
  printf("self_ruid=%u\n", (unsigned)a.self_ruid);
  printf("target=%s\n", a.target);
  printf("cap_sys_ptrace=%s\n", a.has_ptrace_cap ? "yes" : "no");
  printf("match_count=%u\n", a.match_count);
  printf("unknown_count=%u\n", a.unknown_count);
  for (unsigned i = 0; i < a.match_report_n; i++) {
    const struct match_ev *m = &a.matches[i];
    if (m->kind == KIND_FD)
      printf("match pid=%d starttime=%llu kind=fd fd=%d\n", (int)m->pid,
             m->starttime, m->fd);
    else
      printf("match pid=%d starttime=%llu kind=%s\n", (int)m->pid,
             m->starttime, kind_name(m->kind));
  }
  if (a.match_count > a.match_report_n)
    printf("match_truncated=yes omitted=%u\n", a.match_count - a.match_report_n);
  for (unsigned i = 0; i < a.unknown_report_n; i++) {
    const struct unknown_ev *u = &a.unknowns[i];
    printf("unknown reason=%s", u->reason);
    if (u->pid > 0)
      printf(" pid=%d", (int)u->pid);
    if (u->has_kind)
      printf(" kind=%s", kind_name(u->kind));
    if (u->has_fd)
      printf(" fd=%d", u->fd);
    printf("\n");
  }
  if (a.unknown_count > a.unknown_report_n)
    printf("unknown_truncated=yes omitted=%u\n",
           a.unknown_count - a.unknown_report_n);

  close(tfd);
  return (int)st_res;
}
