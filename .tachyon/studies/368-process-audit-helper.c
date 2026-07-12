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
 *
 * TEST_ONLY (compile with -DTEST_ONLY): parent-controlled ready/release marker
 * barriers for deterministic adversarial tests. The hardened production build
 * MUST omit -DTEST_ONLY so the seam is absent from the checksum-pinned binary.
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
#include <signal.h>
#include <time.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* Raw pidfd syscalls (glibc may lack wrappers on older toolchains). */
#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_getfd
#define __NR_pidfd_getfd 438
#endif

#define LINK_BUF 8192
#define MAX_UNKNOWN_REPORT 64
#define MAX_MATCH_REPORT 256
#define MAX_FIXED_POINT 8
#define MAX_PIDS 65536
/*
 * R4 (j-aec448bf6364): complete FD enumeration via pidfd_getfd is bounded by
 * the global stable fs.nr_open ceiling — NOT RLIMIT_NOFILE soft/hard (a process
 * may retain FDs opened before a subsequent soft-limit lowering).
 *
 * Documented safe maximum: probing beyond this is refuse-closed (unknown).
 * Default Linux fs.nr_open is often 1048576; some hosts raise it far higher
 * (this WSL host reports ~2^31), which is not a practical complete probe.
 */
#define PIDFD_NR_OPEN_SAFE_MAX 1048576u
/* Per-process two-scan wall budget (monotonic clock). */
#define PIDFD_SCAN_DEADLINE_MS 2000
/* Occupied-FD evidence capacity for two-scan convergence. */
#define PIDFD_MAX_OCCUPIED 4096

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
  /* Sticky: any target pin/path/identity failure during the audit. */
  bool target_failed;
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
  a->target_failed = true;
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
 * Read the live canonical path of the O_PATH pin via /proc/self/fd.
 * Does not itself decide pass/fail against a->target (caller does).
 */
static bool read_pin_live_path(struct audit *a, char *out, size_t outsz) {
  char fdlink_path[64];
  snprintf(fdlink_path, sizeof(fdlink_path), "/proc/self/fd/%d", a->target_fd);
  ssize_t n = readlink(fdlink_path, out, outsz);
  if (n < 0) {
    add_unknown_critical(a, "target_fd_error");
    return false;
  }
  if ((size_t)n >= outsz) {
    add_unknown_critical(a, "target_fd_error");
    return false;
  }
  out[n] = '\0';
  return true;
}

/*
 * Revalidate pinned target identity against live realpath/stat and the
 * O_PATH descriptor via /proc/self/fd. Fail closed: any mismatch or missing
 * path returns false and records an unknown reason (never under-report).
 * On success, if live_out is non-NULL, fills it with the pin's live path
 * (which must equal a->target byte-for-byte after this check).
 */
static bool revalidate_target(struct audit *a, char *live_out, size_t live_outsz) {
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

  char linkbuf[LINK_BUF];
  if (!read_pin_live_path(a, linkbuf, sizeof(linkbuf)))
    return false;
  /* Unlinked/renamed O_PATH targets surface as "... (deleted)" — fail closed. */
  if (has_deleted_suffix(linkbuf)) {
    add_unknown_critical(a, "target_deleted");
    return false;
  }
  if (strcmp(linkbuf, a->target) != 0) {
    add_unknown_critical(a, "target_path_drift");
    return false;
  }
  if (live_out) {
    if (strlen(linkbuf) + 1 > live_outsz) {
      add_unknown_critical(a, "target_fd_error");
      return false;
    }
    memcpy(live_out, linkbuf, strlen(linkbuf) + 1);
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

/* Occupied-FD classification for two-scan convergence (no path strings stored). */
enum fd_class {
  FD_CLS_BIND = 0,     /* absolute path binds target */
  FD_CLS_NOBIND = 1,   /* absolute path does not bind */
  FD_CLS_NONPATH = 2,  /* pipe/socket/anon/etc */
  FD_CLS_TRUNC = 3,
  FD_CLS_MALFORMED = 4,
  FD_CLS_READ_ERR = 5,
};

struct fd_occ {
  int fd;
  enum fd_class cls;
};

/* Forward decls used by pidfd classification (defined below). */
static enum read_result read_proc_link(const char *path, char *out, size_t outsz);

static int raw_pidfd_open(pid_t pid, unsigned int flags) {
  return (int)syscall(__NR_pidfd_open, pid, flags);
}

static int raw_pidfd_getfd(int pidfd, int targetfd, unsigned int flags) {
  return (int)syscall(__NR_pidfd_getfd, pidfd, targetfd, flags);
}

static bool monotonic_now_ms(uint64_t *out_ms) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
    return false;
  *out_ms = (uint64_t)ts.tv_sec * 1000ull + (uint64_t)ts.tv_nsec / 1000000ull;
  return true;
}

/*
 * Read stable global FD ceiling from /proc/sys/fs/nr_open.
 * TEST_ONLY may override via PAH_TEST_NR_OPEN for bounded regressions.
 * Returns false → caller records unknown (unreadable/malformed/too large).
 */
static bool read_stable_nr_open(unsigned *out, const char **fail_reason) {
#ifdef TEST_ONLY
  {
    const char *ov = getenv("PAH_TEST_NR_OPEN");
    if (ov && *ov) {
      errno = 0;
      unsigned long v = strtoul(ov, NULL, 10);
      if (errno != 0 || v == 0 || v > (unsigned long)PIDFD_NR_OPEN_SAFE_MAX) {
        *fail_reason = "pidfd_nr_open_too_large";
        return false;
      }
      *out = (unsigned)v;
      return true;
    }
  }
#endif
  FILE *f = fopen("/proc/sys/fs/nr_open", "r");
  if (!f) {
    *fail_reason = "pidfd_nr_open_unreadable";
    return false;
  }
  unsigned long v = 0;
  int n = fscanf(f, "%lu", &v);
  fclose(f);
  if (n != 1 || v == 0) {
    *fail_reason = "pidfd_nr_open_unreadable";
    return false;
  }
  if (v > (unsigned long)PIDFD_NR_OPEN_SAFE_MAX) {
    *fail_reason = "pidfd_nr_open_too_large";
    return false;
  }
  *out = (unsigned)v;
  return true;
}

static int cmp_fd_occ(const void *a, const void *b) {
  const struct fd_occ *x = a;
  const struct fd_occ *y = b;
  if (x->fd < y->fd)
    return -1;
  if (x->fd > y->fd)
    return 1;
  return 0;
}

static bool fd_occ_equal(const struct fd_occ *a, unsigned na,
                         const struct fd_occ *b, unsigned nb) {
  if (na != nb)
    return false;
  for (unsigned i = 0; i < na; i++) {
    if (a[i].fd != b[i].fd || a[i].cls != b[i].cls)
      return false;
  }
  return true;
}

/*
 * Classify a duplicated local FD against the live pin (no foreign path print).
 * On target revalidation failure, returns false and leaves *cls undefined;
 * caller treats as fatal process-level unknown (sticky target_failed already set).
 */
static bool classify_local_dup(struct audit *a, int local_fd, enum fd_class *cls) {
  if (a->target_failed)
    return false;

  char live[PATH_MAX];
  if (!revalidate_target(a, live, sizeof(live)))
    return false;

  char lpath[64];
  snprintf(lpath, sizeof(lpath), "/proc/self/fd/%d", local_fd);
  char target_buf[LINK_BUF];
  enum read_result rr = read_proc_link(lpath, target_buf, sizeof(target_buf));
  switch (rr) {
  case RR_OK:
    break;
  case RR_ENOENT:
    /* Dup vanished mid-flight — treat as read error (not absence of remote). */
    *cls = FD_CLS_READ_ERR;
    (void)revalidate_target(a, NULL, 0);
    return true;
  case RR_EACCES:
    *cls = FD_CLS_READ_ERR;
    (void)revalidate_target(a, NULL, 0);
    return true;
  case RR_TRUNC:
    *cls = FD_CLS_TRUNC;
    (void)revalidate_target(a, NULL, 0);
    return true;
  case RR_MALFORMED:
    *cls = FD_CLS_MALFORMED;
    (void)revalidate_target(a, NULL, 0);
    return true;
  case RR_OTHER:
    *cls = FD_CLS_READ_ERR;
    (void)revalidate_target(a, NULL, 0);
    return true;
  }

  strip_deleted_suffix(target_buf);
  if (target_buf[0] != '/') {
    *cls = FD_CLS_NONPATH;
    (void)revalidate_target(a, NULL, 0);
    return true;
  }
  size_t live_len = strlen(live);
  if (path_binds(target_buf, live, live_len))
    *cls = FD_CLS_BIND;
  else
    *cls = FD_CLS_NOBIND;
  (void)revalidate_target(a, NULL, 0);
  return !a->target_failed;
}

/* Map getfd errno (other than EBADF) to a stable unknown reason. */
static const char *pidfd_getfd_fail_reason(int err) {
  switch (err) {
  case ESRCH:
    return "pidfd_getfd_esrch";
  case EPERM:
    return "pidfd_getfd_eperm";
  case EACCES:
    return "pidfd_getfd_eacces";
  case ENOSYS:
    return "pidfd_getfd_enosys";
  case EMFILE:
  case ENFILE:
    return "pidfd_getfd_emfile";
  default:
    return "pidfd_getfd_error";
  }
}

/*
 * One complete probe of [0, nr_open) via pidfd_getfd.
 * EBADF = hole (absence). Any other error aborts with *fail_reason set.
 * Occupied slots recorded in occ[0..*occ_n).
 */
static bool pidfd_probe_once(struct audit *a, pid_t pid, int pidfd,
                             unsigned nr_open, uint64_t deadline_ms,
                             struct fd_occ *occ, unsigned *occ_n,
                             const char **fail_reason, int *fail_fd) {
  *occ_n = 0;
  *fail_fd = -1;
  pid_t self_pid = getpid();
  for (unsigned fdn = 0; fdn < nr_open; fdn++) {
    uint64_t now = 0;
    if (!monotonic_now_ms(&now) || now > deadline_ms) {
      *fail_reason = "pidfd_deadline";
      return false;
    }
    if (a->target_failed) {
      *fail_reason = "target_fd_error";
      return false;
    }

    errno = 0;
    int dupfd = raw_pidfd_getfd(pidfd, (int)fdn, 0);
    if (dupfd < 0) {
      int err = errno;
      if (err == EBADF)
        continue; /* absence */
      *fail_reason = pidfd_getfd_fail_reason(err);
      *fail_fd = (int)fdn;
      return false;
    }

    /*
     * Exclude the helper's own O_PATH target pin from evidence (same as the
     * readdir path). Classify as NOBIND so two-scan agreement stays stable
     * without reporting the pin as a worktree binding.
     */
    if (pid == self_pid && (int)fdn == a->target_fd) {
      close(dupfd);
      if (*occ_n >= PIDFD_MAX_OCCUPIED) {
        *fail_reason = "pidfd_occupied_overflow";
        *fail_fd = (int)fdn;
        return false;
      }
      occ[*occ_n].fd = (int)fdn;
      occ[*occ_n].cls = FD_CLS_NOBIND;
      (*occ_n)++;
      continue;
    }

    /* Occupied — classify then always close the duplicate. */
    enum fd_class cls = FD_CLS_READ_ERR;
    bool ok = classify_local_dup(a, dupfd, &cls);
    close(dupfd);
    if (!ok) {
      *fail_reason = "target_fd_error";
      return false;
    }
    if (*occ_n >= PIDFD_MAX_OCCUPIED) {
      *fail_reason = "pidfd_occupied_overflow";
      *fail_fd = (int)fdn;
      return false;
    }
    occ[*occ_n].fd = (int)fdn;
    occ[*occ_n].cls = cls;
    (*occ_n)++;
  }
  return true;
}

/*
 * R4 fallback: only when same-UID /proc/<pid>/fd readdir fails EACCES/EPERM.
 * Two complete scans under stable nr_open + starttime pin; occupied evidence
 * (fd number + classification) must agree exactly. Never uses RLIMIT_NOFILE.
 */
static void scan_fds_via_pidfd(struct audit *a, pid_t pid, unsigned long long st1,
                               bool *vanished) {
  const char *reason = NULL;
  unsigned nr1 = 0;
  if (!read_stable_nr_open(&nr1, &reason)) {
    add_unknown(a, pid, reason, true, KIND_FD, false, -1);
    return;
  }

  int pidfd = raw_pidfd_open(pid, 0);
  if (pidfd < 0) {
    int err = errno;
    if (err == ESRCH || err == ENOENT) {
      *vanished = true;
      return;
    }
    if (err == ENOSYS)
      add_unknown(a, pid, "pidfd_open_enosys", true, KIND_FD, false, -1);
    else if (err == EPERM || err == EACCES)
      add_unknown(a, pid, "pidfd_open_eperm", true, KIND_FD, false, -1);
    else if (err == EMFILE || err == ENFILE)
      add_unknown(a, pid, "pidfd_open_emfile", true, KIND_FD, false, -1);
    else
      add_unknown(a, pid, "pidfd_open_error", true, KIND_FD, false, -1);
    return;
  }

  unsigned long long st_pre = 0;
  if (!read_starttime(pid, &st_pre)) {
    close(pidfd);
    char p[64];
    snprintf(p, sizeof(p), "/proc/%d", (int)pid);
    if (access(p, F_OK) != 0) {
      *vanished = true;
      return;
    }
    add_unknown(a, pid, "stat_unreadable", false, KIND_CWD, false, -1);
    return;
  }
  if (st_pre != st1) {
    close(pidfd);
    add_unknown(a, pid, "identity_drift", false, KIND_CWD, false, -1);
    return;
  }

  uint64_t t0 = 0;
  if (!monotonic_now_ms(&t0)) {
    close(pidfd);
    add_unknown(a, pid, "pidfd_deadline", true, KIND_FD, false, -1);
    return;
  }
  uint64_t deadline = t0 + (uint64_t)PIDFD_SCAN_DEADLINE_MS;

  struct fd_occ *occ1 = calloc((size_t)PIDFD_MAX_OCCUPIED, sizeof(struct fd_occ));
  struct fd_occ *occ2 = calloc((size_t)PIDFD_MAX_OCCUPIED, sizeof(struct fd_occ));
  if (!occ1 || !occ2) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, "pidfd_oom", true, KIND_FD, false, -1);
    return;
  }

  unsigned n1 = 0, n2 = 0;
  int fail_fd = -1;
  reason = NULL;
  if (!pidfd_probe_once(a, pid, pidfd, nr1, deadline, occ1, &n1, &reason,
                        &fail_fd)) {
    add_unknown(a, pid, reason, true, KIND_FD, fail_fd >= 0, fail_fd);
    free(occ1);
    free(occ2);
    close(pidfd);
    return;
  }

  /* Mid-point identity: starttime + nr_open must be unchanged. */
  unsigned long long st_mid = 0;
  if (!read_starttime(pid, &st_mid) || st_mid != st1) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, "identity_drift", false, KIND_CWD, false, -1);
    return;
  }
  unsigned nr_mid = 0;
  const char *nr_fail = NULL;
  if (!read_stable_nr_open(&nr_mid, &nr_fail)) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, nr_fail, true, KIND_FD, false, -1);
    return;
  }
  if (nr_mid != nr1) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, "pidfd_nr_open_changed", true, KIND_FD, false, -1);
    return;
  }

  reason = NULL;
  fail_fd = -1;
  if (!pidfd_probe_once(a, pid, pidfd, nr1, deadline, occ2, &n2, &reason,
                        &fail_fd)) {
    add_unknown(a, pid, reason, true, KIND_FD, fail_fd >= 0, fail_fd);
    free(occ1);
    free(occ2);
    close(pidfd);
    return;
  }

  unsigned long long st_post = 0;
  if (!read_starttime(pid, &st_post) || st_post != st1) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, "identity_drift", false, KIND_CWD, false, -1);
    return;
  }
  unsigned nr_post = 0;
  if (!read_stable_nr_open(&nr_post, &reason) || nr_post != nr1) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, "pidfd_nr_open_changed", true, KIND_FD, false, -1);
    return;
  }

  /* Deterministic compare: sort then require exact agreement. */
  qsort(occ1, n1, sizeof(struct fd_occ), cmp_fd_occ);
  qsort(occ2, n2, sizeof(struct fd_occ), cmp_fd_occ);
  if (!fd_occ_equal(occ1, n1, occ2, n2)) {
    free(occ1);
    free(occ2);
    close(pidfd);
    add_unknown(a, pid, "pidfd_scan_disagreement", true, KIND_FD, false, -1);
    return;
  }

  /* Commit agreed occupied evidence into the audit report. */
  for (unsigned i = 0; i < n1; i++) {
    int fd = occ1[i].fd;
    switch (occ1[i].cls) {
    case FD_CLS_BIND:
      add_match(a, pid, st1, KIND_FD, fd);
      break;
    case FD_CLS_NOBIND:
    case FD_CLS_NONPATH:
      break;
    case FD_CLS_TRUNC:
      add_unknown(a, pid, "truncation", true, KIND_FD, true, fd);
      break;
    case FD_CLS_MALFORMED:
      add_unknown(a, pid, "malformed_link", true, KIND_FD, true, fd);
      break;
    case FD_CLS_READ_ERR:
      add_unknown(a, pid, "read_error", true, KIND_FD, true, fd);
      break;
    }
  }

  free(occ1);
  free(occ2);
  close(pidfd);
}

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

#ifdef TEST_ONLY
/*
 * Parent-controlled ready/release markers (compile-time TEST_ONLY only).
 * Env:
 *   PAH_TEST_SEAM_DIR   — directory for <phase>.ready / <phase>.release
 *   PAH_TEST_SEAM_PHASE — exact phase name to arm ("post_pin" or "obs");
 *                         other phases no-op so only one barrier is active.
 * Creates ready, then blocks until release appears. Absent env → no-op so
 * non-barrier runs of the TEST_ONLY binary still work.
 */
static void test_seam_barrier(const char *phase) {
  const char *dir = getenv("PAH_TEST_SEAM_DIR");
  const char *want = getenv("PAH_TEST_SEAM_PHASE");
  if (!dir || !*dir || !want || !*want || !phase || !*phase)
    return;
  if (strcmp(want, phase) != 0)
    return;
  char ready[PATH_MAX];
  char release[PATH_MAX];
  if (snprintf(ready, sizeof(ready), "%s/%s.ready", dir, phase) >= (int)sizeof(ready))
    return;
  if (snprintf(release, sizeof(release), "%s/%s.release", dir, phase) >=
      (int)sizeof(release))
    return;
  int fd = open(ready, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd >= 0)
    close(fd);
  /* Bounded wait so a stuck test cannot hang forever (≈30s). */
  for (int i = 0; i < 30000; i++) {
    if (access(release, F_OK) == 0)
      return;
    usleep(1000);
  }
}

#define TEST_SEAM(phase) test_seam_barrier(phase)

/*
 * Deterministic high-FD-above-soft-limit child for R4 regression.
 * Env PAH_TEST_SPAWN_HIGH_FD=<n>: fork a child that opens the audit target at
 * FD n, then lowers RLIMIT_NOFILE soft below n (proving soft-bound incompleteness),
 * and remains alive for the duration of the audit. Parent relationship preserves
 * pidfd_getfd permission under Yama ptrace_scope=1 without CAP_SYS_PTRACE.
 * Hardened builds omit this seam entirely.
 */
static pid_t test_spawned_high_fd_child = -1;

static void test_cleanup_high_fd_child(void) {
  if (test_spawned_high_fd_child > 0) {
    char softpath[64];
    snprintf(softpath, sizeof(softpath), "/tmp/pah-test-soft-%d",
             (int)test_spawned_high_fd_child);
    unlink(softpath);
    kill(test_spawned_high_fd_child, SIGKILL);
    int st = 0;
    (void)waitpid(test_spawned_high_fd_child, &st, 0);
    test_spawned_high_fd_child = -1;
  }
}

static bool test_maybe_spawn_high_fd_child(const char *target) {
  const char *s = getenv("PAH_TEST_SPAWN_HIGH_FD");
  if (!s || !*s)
    return true;
  errno = 0;
  long high = strtol(s, NULL, 10);
  if (errno != 0 || high < 8 || high > 100000) {
    fprintf(stderr, "error=test_high_fd_invalid\n");
    return false;
  }

  int ready[2];
  if (pipe(ready) != 0) {
    fprintf(stderr, "error=test_high_fd_pipe\n");
    return false;
  }
  pid_t c = fork();
  if (c < 0) {
    close(ready[0]);
    close(ready[1]);
    fprintf(stderr, "error=test_high_fd_fork\n");
    return false;
  }
  if (c == 0) {
    close(ready[0]);
    /* Open target directory and place it at the requested high FD. */
    int t = open(target, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (t < 0)
      _exit(11);
    if (dup2(t, (int)high) < 0)
      _exit(12);
    if (t != (int)high)
      close(t);
    /* Lower soft limit strictly below the high FD (hard limit unchanged). */
    struct rlimit rl;
    if (getrlimit(RLIMIT_NOFILE, &rl) != 0)
      _exit(13);
    rlim_t soft = (rlim_t)high / 2;
    if (soft < 8)
      soft = 8;
    if (soft >= (rlim_t)high)
      soft = (rlim_t)high - 1;
    if (soft > rl.rlim_max)
      soft = rl.rlim_max;
    rl.rlim_cur = soft;
    if (setrlimit(RLIMIT_NOFILE, &rl) != 0)
      _exit(14);
    /* Publish soft limit for the parent test to assert soft-bound miss. */
    char softpath[64];
    snprintf(softpath, sizeof(softpath), "/tmp/pah-test-soft-%d", (int)getpid());
    FILE *sf = fopen(softpath, "w");
    if (sf) {
      fprintf(sf, "%llu\n", (unsigned long long)soft);
      fclose(sf);
    }
    /* Ready byte then sleep until killed. */
    char one = 'R';
    if (write(ready[1], &one, 1) != 1) {
      close(ready[1]);
      _exit(15);
    }
    close(ready[1]);
    for (;;)
      pause();
    _exit(0);
  }
  close(ready[1]);
  char b = 0;
  ssize_t n = read(ready[0], &b, 1);
  close(ready[0]);
  if (n != 1 || b != 'R') {
    kill(c, SIGKILL);
    (void)waitpid(c, NULL, 0);
    fprintf(stderr, "error=test_high_fd_ready\n");
    return false;
  }
  test_spawned_high_fd_child = c;
  atexit(test_cleanup_high_fd_child);
  return true;
}
#else
#define TEST_SEAM(phase) ((void)0)
#endif

/*
 * Per-observation check: revalidate pin, obtain live /proc/self/fd path, then
 * after the caller's procfs read, revalidate again. Any pre/post path or
 * identity drift → target_* unknown (sticky fail-closed). Binding comparison
 * uses the live pin path captured at pre-check time.
 *
 * Residual (irreducible with this readlink primitive): a malicious same-UID
 * actor that coordinates move+restore entirely between the separate procfs
 * syscalls inside this window cannot be mathematically excluded.
 */
static void consider_link(struct audit *a, pid_t pid, unsigned long long st,
                          enum link_kind kind, int fd, const char *linkpath) {
  if (a->target_failed)
    return;

  char live[PATH_MAX];
  if (!revalidate_target(a, live, sizeof(live)))
    return;

  /* Deterministic test barrier at the intended observation (once per run). */
#ifdef TEST_ONLY
  {
    static bool obs_seam_done = false;
    if (!obs_seam_done) {
      obs_seam_done = true;
      TEST_SEAM("obs");
      /* Re-check immediately after release so a held rename is observed. */
      if (!revalidate_target(a, live, sizeof(live)))
        return;
    }
  }
#endif

  char target_buf[LINK_BUF];
  enum read_result rr = read_proc_link(linkpath, target_buf, sizeof(target_buf));
  switch (rr) {
  case RR_OK:
    break;
  case RR_ENOENT:
    /* Vanishing process/FD is handled by fixed-point rescan at outer level
     * for whole-process ENOENT; for individual FDs, skip quietly. */
    if (!revalidate_target(a, NULL, 0))
      return;
    return;
  case RR_EACCES:
    add_unknown(a, pid, "eaccess", true, kind, kind == KIND_FD, fd);
    if (!revalidate_target(a, NULL, 0))
      return;
    return;
  case RR_TRUNC:
    add_unknown(a, pid, "truncation", true, kind, kind == KIND_FD, fd);
    if (!revalidate_target(a, NULL, 0))
      return;
    return;
  case RR_MALFORMED:
    add_unknown(a, pid, "malformed_link", true, kind, kind == KIND_FD, fd);
    if (!revalidate_target(a, NULL, 0))
      return;
    return;
  case RR_OTHER:
    add_unknown(a, pid, "read_error", true, kind, kind == KIND_FD, fd);
    if (!revalidate_target(a, NULL, 0))
      return;
    return;
  }

  strip_deleted_suffix(target_buf);

  /* Non-path pseudo targets cannot bind a directory. */
  if (target_buf[0] != '/') {
    if (!revalidate_target(a, NULL, 0))
      return;
    return;
  }

  /* Compare candidate against the pinned live path from pre-observation. */
  size_t live_len = strlen(live);
  if (path_binds(target_buf, live, live_len))
    add_match(a, pid, st, kind, kind == KIND_FD ? fd : -1);

  /* Post-observation: any path/identity drift fails closed. */
  (void)revalidate_target(a, NULL, 0);
}

static bool scan_one_pid(struct audit *a, pid_t pid, bool *vanished) {
  *vanished = false;
  if (a->target_failed)
    return true;

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
  if (a->target_failed)
    return true;

  snprintf(linkpath, sizeof(linkpath), "/proc/%d/root", (int)pid);
  consider_link(a, pid, st1, KIND_ROOT, -1, linkpath);
  if (a->target_failed)
    return true;

  char fddir[64];
  snprintf(fddir, sizeof(fddir), "/proc/%d/fd", (int)pid);
#ifdef TEST_ONLY
  /* Force pidfd path even when readdir would work — parent/child regressions. */
  bool force_pidfd = false;
  {
    const char *fp = getenv("PAH_TEST_FORCE_PIDFD_FD_SCAN");
    force_pidfd = fp && fp[0] == '1' && fp[1] == '\0';
  }
#else
  const bool force_pidfd = false;
#endif
  DIR *d = force_pidfd ? NULL : opendir(fddir);
  if (!d) {
    int oerr = errno;
    if (!force_pidfd && (oerr == ENOENT || oerr == ESRCH)) {
      *vanished = true;
      return true;
    }
    /*
     * R4: same-UID fd-directory EACCES/EPERM → pidfd_getfd fallback under
     * stable fs.nr_open (never RLIMIT_NOFILE). TEST_ONLY force also lands here.
     */
    if (force_pidfd || oerr == EACCES || oerr == EPERM) {
      scan_fds_via_pidfd(a, pid, st1, vanished);
    } else {
      add_unknown(a, pid, "fd_dir_error", true, KIND_FD, false, -1);
    }
  } else {
    pid_t self_pid = getpid();
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
      if (a->target_failed)
        break;
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

  if (a->target_failed)
    return true;

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
    /* target_failed is sticky: once set mid-scan we return ST_UNKNOWN before
     * the next pass reset, so a true value here would be a logic error. */

    /* F2: sticky capability_loss is re-counted/reported every pass so a final
     * stable pass can never print state=unknown with unknown_count=0/no reason
     * after an earlier-pass loss observation. */
    if (a->has_ptrace_cap && !cap_sys_ptrace_effective())
      a->saw_cap_loss = true;
    if (a->saw_cap_loss)
      add_unknown(a, 0, "capability_loss", false, KIND_CWD, false, -1);

    /* Pass-level pre revalidation (preserved; per-observation also checks). */
    if (!revalidate_target(a, NULL, 0)) {
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
      if (a->target_failed)
        break;
      bool vanished = false;
      scan_one_pid(a, pids[i], &vanished);
      if (vanished)
        any_vanished = true;
    }

    if (a->target_failed) {
      free(pids);
      return ST_UNKNOWN;
    }

    /* Pass-level post revalidation — rename/replacement/deletion mid-scan
     * fails closed to unknown (never under-report as empty). */
    if (!revalidate_target(a, NULL, 0)) {
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

static void emit_report(struct audit *a, enum state st_res) {
  const char *state_s = st_res == ST_EMPTY
                            ? "empty"
                            : st_res == ST_SURVIVORS ? "survivors" : "unknown";

  /* Machine-readable stable output. No unrelated path strings. */
  printf("state=%s\n", state_s);
  printf("self_ruid=%u\n", (unsigned)a->self_ruid);
  printf("target=%s\n", a->target);
  printf("cap_sys_ptrace=%s\n", a->has_ptrace_cap ? "yes" : "no");
  printf("match_count=%u\n", a->match_count);
  printf("unknown_count=%u\n", a->unknown_count);
  for (unsigned i = 0; i < a->match_report_n; i++) {
    const struct match_ev *m = &a->matches[i];
    if (m->kind == KIND_FD)
      printf("match pid=%d starttime=%llu kind=fd fd=%d\n", (int)m->pid,
             m->starttime, m->fd);
    else
      printf("match pid=%d starttime=%llu kind=%s\n", (int)m->pid,
             m->starttime, kind_name(m->kind));
  }
  if (a->match_count > a->match_report_n)
    printf("match_truncated=yes omitted=%u\n", a->match_count - a->match_report_n);
  for (unsigned i = 0; i < a->unknown_report_n; i++) {
    const struct unknown_ev *u = &a->unknowns[i];
    printf("unknown reason=%s", u->reason);
    if (u->pid > 0)
      printf(" pid=%d", (int)u->pid);
    if (u->has_kind)
      printf(" kind=%s", kind_name(u->kind));
    if (u->has_fd)
      printf(" fd=%d", u->fd);
    printf("\n");
  }
  if (a->unknown_count > a->unknown_report_n)
    printf("unknown_truncated=yes omitted=%u\n",
           a->unknown_count - a->unknown_report_n);
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
   * Pin: independent realpath must equal the caller string byte-for-byte
   * (rejects symlink aliases and non-canonical inputs). Then open
   * O_PATH|O_DIRECTORY|O_CLOEXEC and pin st_dev+st_ino for every-pass and
   * per-observation revalidation.
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
  if (!revalidate_target(&a, NULL, 0)) {
    emit_report(&a, ST_UNKNOWN);
    close(tfd);
    return ST_UNKNOWN;
  }

  /* Deterministic test barrier immediately after successful target pin. */
  TEST_SEAM("post_pin");

  /* After release, re-check so a rename held across the barrier is observed
   * before any process scan begins. */
  if (!revalidate_target(&a, NULL, 0)) {
    emit_report(&a, ST_UNKNOWN);
    close(tfd);
    return ST_UNKNOWN;
  }

#ifdef TEST_ONLY
  /* Optional R4 high-FD child (parent-owned) for pidfd fallback regression. */
  if (!test_maybe_spawn_high_fd_child(target)) {
    close(tfd);
    return ST_ERROR;
  }
#endif

  enum state st_res = run_audit(&a);
  if (st_res == ST_ERROR) {
#ifdef TEST_ONLY
    test_cleanup_high_fd_child();
#endif
    close(tfd);
    return ST_ERROR;
  }

  emit_report(&a, st_res);
#ifdef TEST_ONLY
  test_cleanup_high_fd_child();
#endif
  close(tfd);
  return (int)st_res;
}
