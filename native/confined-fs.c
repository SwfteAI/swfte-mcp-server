/* SPDX-License-Identifier: MIT
 * SWFTE_CF1: a single bounded operation against inherited directory fd 3.
 * This is inode-capability confinement, not protection against a malicious
 * same-UID process moving directories or linking/modifying staged inodes.
 * No preexisting target is opened for writing or truncated. Replacement is
 * atomic per directory entry, not compare-and-swap or a multi-file transaction.
 */
#define _POSIX_C_SOURCE 200809L
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <dirent.h>

#if !defined(O_NOFOLLOW) || !defined(O_DIRECTORY) || !defined(O_CLOEXEC) || !defined(AT_SYMLINK_NOFOLLOW)
#error "Descriptor confinement primitives are required; no weaker fallback."
#endif

#define FILE_CAP (4u * 1024u * 1024u)
#define REQUEST_CAP (2u * FILE_CAP + 65536u)
#define COMPONENT_CAP 64u
#define PATH_CAP 4096u
#define META_SIZE 60u
#define LIST_ENTRIES_CAP 20000u
static const unsigned char MAGIC[8] = {'S','W','F','T','E','C','F','1'};

typedef struct { const unsigned char *data; size_t size, at; int bad; } Cursor;
typedef struct { uint16_t count; char part[COMPONENT_CAP][256]; } Path;
typedef struct {
  uint64_t dev, ino, nlink, size;
  uint32_t mode, mtime_ns, ctime_ns;
  int64_t mtime_sec, ctime_sec;
} Meta;
typedef struct { Meta meta; unsigned char *bytes; uint32_t length; } Snapshot;
typedef struct {
  unsigned char op, policy, has_expected;
  uint64_t root_dev, root_ino;
  Path path;
  uint32_t cap, length, entry_cap;
  Meta expected_meta;
  const unsigned char *expected_bytes, *bytes;
  uint32_t expected_length;
} Request;
static int published = 0;

static uint64_t take(Cursor *c, unsigned n) {
  uint64_t out = 0;
  if (c->bad || n > c->size - c->at) { c->bad = 1; return 0; }
  for (unsigned i = 0; i < n; ++i) out = (out << 8) | c->data[c->at++];
  return out;
}
static const unsigned char *take_bytes(Cursor *c, size_t n) {
  if (c->bad || n > c->size - c->at) { c->bad = 1; return NULL; }
  const unsigned char *out = c->data + c->at; c->at += n; return out;
}
static void put(unsigned char **p, uint64_t value, unsigned n) {
  for (unsigned i = n; i > 0; --i) { (*p)[i - 1] = (unsigned char)(value & 255); value >>= 8; }
  *p += n;
}
static Meta parse_meta(Cursor *c) {
  Meta m;
  m.dev = take(c,8); m.ino = take(c,8); m.mode = (uint32_t)take(c,4);
  m.nlink = take(c,8); m.size = take(c,8);
  m.mtime_sec = (int64_t)take(c,8); m.mtime_ns = (uint32_t)take(c,4);
  m.ctime_sec = (int64_t)take(c,8); m.ctime_ns = (uint32_t)take(c,4);
  return m;
}
static void put_meta(unsigned char **p, const Meta *m) {
  put(p,m->dev,8); put(p,m->ino,8); put(p,m->mode,4); put(p,m->nlink,8); put(p,m->size,8);
  put(p,(uint64_t)m->mtime_sec,8); put(p,m->mtime_ns,4);
  put(p,(uint64_t)m->ctime_sec,8); put(p,m->ctime_ns,4);
}
static Meta stat_meta(const struct stat *st) {
  Meta m;
  m.dev = (uint64_t)st->st_dev; m.ino = (uint64_t)st->st_ino;
  m.mode = (uint32_t)st->st_mode; m.nlink = (uint64_t)st->st_nlink; m.size = (uint64_t)st->st_size;
#ifdef __APPLE__
  m.mtime_sec = st->st_mtimespec.tv_sec; m.mtime_ns = (uint32_t)st->st_mtimespec.tv_nsec;
  m.ctime_sec = st->st_ctimespec.tv_sec; m.ctime_ns = (uint32_t)st->st_ctimespec.tv_nsec;
#else
  m.mtime_sec = st->st_mtim.tv_sec; m.mtime_ns = (uint32_t)st->st_mtim.tv_nsec;
  m.ctime_sec = st->st_ctim.tv_sec; m.ctime_ns = (uint32_t)st->st_ctim.tv_nsec;
#endif
  return m;
}
static int same_meta(const Meta *a, const Meta *b) {
  return a->dev == b->dev && a->ino == b->ino && a->mode == b->mode && a->nlink == b->nlink
    && a->size == b->size && a->mtime_sec == b->mtime_sec && a->mtime_ns == b->mtime_ns
    && a->ctime_sec == b->ctime_sec && a->ctime_ns == b->ctime_ns;
}
static int valid_component(const unsigned char *p, size_t n) {
  if (!n || n > 255 || (n == 1 && p[0] == '.') || (n == 2 && p[0] == '.' && p[1] == '.')) return 0;
  for (size_t i = 0; i < n;) {
    unsigned char b = p[i++];
    if (b < 32 || b == 127 || b == '/' || b == '\\') return 0;
    if (b < 128) continue;
    uint32_t code; unsigned rest;
    if (b >= 0xc2 && b <= 0xdf) { code = b & 31u; rest = 1; }
    else if (b >= 0xe0 && b <= 0xef) { code = b & 15u; rest = 2; }
    else if (b >= 0xf0 && b <= 0xf4) { code = b & 7u; rest = 3; }
    else return 0;
    if (rest > n - i) return 0;
    unsigned width = rest;
    while (rest--) { unsigned char next = p[i++]; if ((next & 0xc0) != 0x80) return 0; code = (code << 6) | (next & 63u); }
    if ((width == 2 && code < 0x800) || (width == 3 && code < 0x10000)
      || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
  }
  return 1;
}
static const char *parse_request(const unsigned char *data, size_t length, Request *r) {
  if (length < 34) return "PROTOCOL_INVALID";
  Cursor c = {data,length,0,0};
  const unsigned char *magic = take_bytes(&c,8);
  if (!magic || memcmp(magic,MAGIC,8) || take(&c,4) != 1) return "PROTOCOL_INVALID";
  r->op = (unsigned char)take(&c,1);
  if (take(&c,1) || take(&c,2) || r->op > 5) return "PROTOCOL_INVALID";
  r->root_dev = take(&c,8); r->root_ino = take(&c,8);
  r->path.count = (uint16_t)take(&c,2);
  if (r->path.count > COMPONENT_CAP || (!r->op && r->path.count) || (r->op && r->op != 4 && !r->path.count)) return "PATH_REFUSED";
  size_t path_bytes = 0;
  for (uint16_t i = 0; i < r->path.count; ++i) {
    size_t n = (size_t)take(&c,2); const unsigned char *part = take_bytes(&c,n);
    if (!part) return "PROTOCOL_INVALID";
    if (!valid_component(part,n) || (path_bytes += n + (i ? 1u : 0u)) > PATH_CAP) return "PATH_REFUSED";
    memcpy(r->path.part[i],part,n); r->path.part[i][n] = 0;
  }
  if (r->op == 1) {
    r->cap = (uint32_t)take(&c,4);
    if (c.bad) return "PROTOCOL_INVALID";
    if (!r->cap || r->cap > FILE_CAP) return "SIZE_LIMIT";
  } else if (r->op == 2) {
    r->policy = (unsigned char)take(&c,1); r->has_expected = (unsigned char)take(&c,1);
    if (c.bad) return "PROTOCOL_INVALID";
    if (r->policy < 1 || r->policy > 3 || r->has_expected > 1 || (r->policy == 1 && r->has_expected)) return "PROTOCOL_INVALID";
    if (r->has_expected) {
      r->expected_meta = parse_meta(&c); r->expected_length = (uint32_t)take(&c,4);
      if (c.bad) return "PROTOCOL_INVALID";
      if (r->expected_length > FILE_CAP || r->expected_meta.size != r->expected_length
        || r->expected_meta.nlink != 1 || r->expected_meta.mtime_ns >= 1000000000u || r->expected_meta.ctime_ns >= 1000000000u) return "PROTOCOL_INVALID";
      r->expected_bytes = take_bytes(&c,r->expected_length);
    }
    r->length = (uint32_t)take(&c,4);
    if (c.bad) return "PROTOCOL_INVALID";
    if (r->length > FILE_CAP) return "SIZE_LIMIT";
    r->bytes = take_bytes(&c,r->length);
  } else if (r->op == 4) {
    r->entry_cap = (uint32_t)take(&c,4); r->cap = (uint32_t)take(&c,4);
    if (c.bad) return "PROTOCOL_INVALID";
    if (!r->entry_cap || r->entry_cap > LIST_ENTRIES_CAP || !r->cap || r->cap > FILE_CAP) return "SIZE_LIMIT";
  } else if (r->op == 5) {
    r->expected_meta = parse_meta(&c); r->expected_length = (uint32_t)take(&c,4);
    if (c.bad) return "PROTOCOL_INVALID";
    if (r->expected_length > FILE_CAP || r->expected_meta.size != r->expected_length
      || r->expected_meta.nlink != 1 || !S_ISREG((mode_t)r->expected_meta.mode)
      || r->expected_meta.mtime_ns >= 1000000000u || r->expected_meta.ctime_ns >= 1000000000u) return "PROTOCOL_INVALID";
    r->expected_bytes = take_bytes(&c,r->expected_length);
  }
  return c.bad || c.at != c.size ? "PROTOCOL_INVALID" : NULL;
}
static int write_all(int fd, const unsigned char *data, size_t length) {
  size_t at = 0;
  while (at < length) {
    ssize_t n = write(fd,data + at,length - at);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    at += (size_t)n;
  }
  return 0;
}
static const char *path_error(int parent, const char *name) {
  struct stat st;
  if (!fstatat(parent,name,&st,AT_SYMLINK_NOFOLLOW) && S_ISLNK(st.st_mode)) return "SYMLINK_REFUSED";
  return errno == ELOOP ? "SYMLINK_REFUSED" : "PATH_REFUSED";
}
/* Every lookup is relative to a held directory capability, never an absolute pathname. */
static const char *directory(const Path *path, uint16_t count, int create, int *fd, int *missing) {
  int current = fcntl(3,F_DUPFD_CLOEXEC,5);
  if (current < 0) return "IO_ERROR";
  *missing = 0;
  for (uint16_t i = 0; i < count; ++i) {
    int next = openat(current,path->part[i],O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 && errno == ENOENT && create) {
      int made = mkdirat(current,path->part[i],0700);
      if (made < 0 && errno != EEXIST) { close(current); return "IO_ERROR"; }
      if (!made) published = 1;
      next = openat(current,path->part[i],O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (next < 0) {
      int saved = errno;
      if (saved == ENOENT && !create) { *missing = 1; close(current); *fd = -1; return NULL; }
      const char *error = path_error(current,path->part[i]); close(current); return error;
    }
    struct stat st;
    if (fstat(next,&st) || !S_ISDIR(st.st_mode)) { close(next); close(current); return "PATH_REFUSED"; }
    close(current); current = next;
  }
  *fd = current; return NULL;
}
static const char *snapshot_fd(int fd, uint32_t cap, Snapshot *s) {
  struct stat before, after;
  if (fstat(fd,&before)) return "IO_ERROR";
  if (!S_ISREG(before.st_mode)) return "PATH_REFUSED";
  if (before.st_nlink != 1) return "HARDLINK_REFUSED";
  if (before.st_size < 0 || (uint64_t)before.st_size > cap) return "SIZE_LIMIT";
  size_t expected = (size_t)before.st_size;
  s->bytes = malloc(expected + 1);
  if (!s->bytes) return "IO_ERROR";
  size_t at = 0;
  while (at < expected + 1) {
    ssize_t n = pread(fd,s->bytes + at,expected + 1 - at,(off_t)at);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { free(s->bytes); s->bytes = NULL; return "IO_ERROR"; }
    if (!n) break;
    at += (size_t)n;
  }
  if (fstat(fd,&after)) { free(s->bytes); s->bytes = NULL; return "IO_ERROR"; }
  Meta first = stat_meta(&before), last = stat_meta(&after);
  if (after.st_nlink != 1 || at != expected || !same_meta(&first,&last)) {
    free(s->bytes); s->bytes = NULL; return after.st_nlink != 1 ? "HARDLINK_REFUSED" : "STALE_CONTENT";
  }
  s->meta = last; s->length = (uint32_t)at; return NULL;
}
static const char *read_snapshot(int parent, const char *name, uint32_t cap, Snapshot *s, int *exists) {
  *exists = 0;
  struct stat st;
  if (fstatat(parent,name,&st,AT_SYMLINK_NOFOLLOW)) return errno == ENOENT ? NULL : "IO_ERROR";
  if (S_ISLNK(st.st_mode)) return "SYMLINK_REFUSED";
  if (!S_ISREG(st.st_mode)) return "PATH_REFUSED";
  if (st.st_nlink != 1) return "HARDLINK_REFUSED";
  int fd = openat(parent,name,O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return errno == ENOENT ? "STALE_CONTENT" : path_error(parent,name);
  const char *error = snapshot_fd(fd,cap,s); close(fd);
  if (!error) *exists = 1;
  return error;
}
static int expected_matches(const Request *r, const Snapshot *s) {
  return same_meta(&r->expected_meta,&s->meta) && r->expected_length == s->length
    && (!s->length || !memcmp(r->expected_bytes,s->bytes,s->length));
}
/* One directory observation. A fresh open file description prevents a DIR stream from
 * changing the inherited capability's shared directory offset across subprocesses. */
static const char *list_directory(const Request *r, unsigned char **output, uint32_t *length) {
  int parent = -1, missing = 0, stream_fd = -1;
  DIR *stream = NULL;
  unsigned char *buffer = NULL;
  const char *error = directory(&r->path,r->path.count,0,&parent,&missing);
  if (error) return error;
  if (missing) {
    buffer = malloc(1);
    if (!buffer) return "IO_ERROR";
    buffer[0] = 0; *output = buffer; *length = 1; return NULL;
  }
  if (r->cap < 1u + META_SIZE + 4u) { error = "SIZE_LIMIT"; goto done; }
  stream_fd = openat(parent,".",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (stream_fd < 0) { error = "IO_ERROR"; goto done; }
  stream = fdopendir(stream_fd);
  if (!stream) { error = "IO_ERROR"; goto done; }
  stream_fd = -1; /* closedir owns it now. */
  struct stat before, after;
  if (fstat(dirfd(stream),&before) || !S_ISDIR(before.st_mode)) { error = "PATH_REFUSED"; goto done; }
  uint32_t capacity = r->cap < 1024u ? r->cap : 1024u;
  buffer = malloc(capacity);
  if (!buffer) { error = "IO_ERROR"; goto done; }
  uint32_t used = 1u + META_SIZE + 4u, count = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (!entry) { if (errno) error = "IO_ERROR"; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    size_t name_length = strlen(entry->d_name);
    if (!valid_component((const unsigned char *)entry->d_name,name_length)) { error = "PATH_REFUSED"; break; }
    uint32_t record_length = 2u + (uint32_t)name_length + 1u + META_SIZE;
    if (count >= r->entry_cap || record_length > r->cap - used) { error = "SIZE_LIMIT"; break; }
    struct stat named;
    if (fstatat(dirfd(stream),entry->d_name,&named,AT_SYMLINK_NOFOLLOW)) {
      error = errno == ENOENT ? "STALE_CONTENT" : "IO_ERROR"; break;
    }
    if (used + record_length > capacity) {
      uint32_t next = capacity;
      while (next < used + record_length) next = next > r->cap / 2u ? r->cap : next * 2u;
      unsigned char *grown = realloc(buffer,next);
      if (!grown) { error = "IO_ERROR"; break; }
      buffer = grown; capacity = next;
    }
    unsigned char *at = buffer + used;
    put(&at,name_length,2); memcpy(at,entry->d_name,name_length); at += name_length;
    unsigned kind = S_ISREG(named.st_mode) ? 1u : S_ISDIR(named.st_mode) ? 2u : S_ISLNK(named.st_mode) ? 3u : 4u;
    Meta meta = stat_meta(&named); put(&at,kind,1); put_meta(&at,&meta);
    used += record_length; count++;
  }
  if (!error) {
    if (fstat(dirfd(stream),&after)) error = "IO_ERROR";
    else {
      Meta first = stat_meta(&before), last = stat_meta(&after);
      if (!same_meta(&first,&last)) error = "STALE_CONTENT";
      else { unsigned char *at = buffer; put(&at,1,1); put_meta(&at,&last); put(&at,count,4); *length = used; }
    }
  }
done:
  if (stream && closedir(stream) && !error) error = "IO_ERROR";
  if (stream_fd >= 0) close(stream_fd);
  if (parent >= 0) close(parent);
  if (error) free(buffer);
  else *output = buffer;
  return error;
}

/* This comparison is NOT kernel compare-and-unlink. Same-UID/name substitution
 * after the final check remains outside the capability's concurrency guarantee. */
static const char *unlink_file(const Request *r, unsigned char *removed) {
  int parent = -1, missing = 0, exists = 0;
  Snapshot current = {0};
  const char *error = directory(&r->path,(uint16_t)(r->path.count - 1),0,&parent,&missing);
  if (error || missing) return error;
  const char *leaf = r->path.part[r->path.count - 1];
  error = read_snapshot(parent,leaf,FILE_CAP,&current,&exists);
  if (error || !exists) goto done;
  if (!expected_matches(r,&current)) { error = "STALE_CONTENT"; goto done; }
  struct stat named;
  if (fstatat(parent,leaf,&named,AT_SYMLINK_NOFOLLOW)) { error = errno == ENOENT ? "STALE_CONTENT" : "IO_ERROR"; goto done; }
  if (S_ISLNK(named.st_mode)) { error = "SYMLINK_REFUSED"; goto done; }
  if (!S_ISREG(named.st_mode)) { error = "PATH_REFUSED"; goto done; }
  if (named.st_nlink != 1) { error = "HARDLINK_REFUSED"; goto done; }
  Meta entry = stat_meta(&named);
  if (!same_meta(&entry,&current.meta)) { error = "STALE_CONTENT"; goto done; }
  if (unlinkat(parent,leaf,0)) { error = errno == ENOENT ? "STALE_CONTENT" : "IO_ERROR"; goto done; }
  published = 1; *removed = 1;
  if (!fstatat(parent,leaf,&named,AT_SYMLINK_NOFOLLOW) || errno != ENOENT) { error = "STALE_CONTENT"; goto done; }
  if (fsync(parent)) error = "IO_ERROR";
done:
  free(current.bytes); close(parent); return error;
}

static const char *random_name(char name[48]) {
  unsigned char random[16]; size_t at = 0;
  int fd = open("/dev/urandom",O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return "IO_ERROR";
  while (at < sizeof random) {
    ssize_t n = read(fd,random + at,sizeof random - at);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { close(fd); return "IO_ERROR"; }
    at += (size_t)n;
  }
  close(fd); memcpy(name,".swfte-cf-",10);
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < sizeof random; ++i) { name[10 + i * 2] = hex[random[i] >> 4]; name[11 + i * 2] = hex[random[i] & 15]; }
  name[42] = 0; return NULL;
}
static const char *replace_file(const Request *r, Snapshot *out, unsigned char *action) {
  int parent = -1, missing = 0, stage = -1, file = -1, exists = 0;
  int stage_created = 0, staged_file = 0;
  char stage_name[48] = {0}; struct stat stage_stat = {0}; int stage_identity = 0;
  Snapshot before = {0}, current = {0};
  const char *error = directory(&r->path,(uint16_t)(r->path.count - 1),0,&parent,&missing);
  if (error || missing) return error ? error : "PATH_REFUSED";
  const char *leaf = r->path.part[r->path.count - 1];
  error = read_snapshot(parent,leaf,FILE_CAP,&before,&exists);
  if (error) goto done;
  if (exists != r->has_expected) { error = exists && r->policy == 1 ? "CONFLICT" : "STALE_CONTENT"; goto done; }
  if (exists && !expected_matches(r,&before)) { error = "STALE_CONTENT"; goto done; }
  if (exists && before.length == r->length && (!r->length || !memcmp(before.bytes,r->bytes,r->length))) {
    *out = before; before.bytes = NULL; *action = 4; goto done;
  }
  for (unsigned attempt = 0; attempt < 8; ++attempt) {
    error = random_name(stage_name); if (error) goto done;
    if (!mkdirat(parent,stage_name,0700)) { stage_created = 1; break; }
    if (errno != EEXIST) { error = "IO_ERROR"; goto done; }
  }
  if (!stage_created) { error = "IO_ERROR"; goto done; }
  stage = openat(parent,stage_name,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (stage < 0 || fstat(stage,&stage_stat)) { error = "IO_ERROR"; goto done; }
  stage_identity = 1;
  file = openat(stage,"payload",O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);
  if (file < 0) { error = "IO_ERROR"; goto done; }
  staged_file = 1;
  mode_t publish_mode = (mode_t)(before.meta.mode & 0777u);
  if (!exists) {
    /* This single-threaded helper inherits the caller's mask. fchmod otherwise bypasses it.
     * Restore the mask immediately; no file creation happens while it is temporarily zero. */
    mode_t inherited_mask = umask(0);
    umask(inherited_mask);
    publish_mode = (mode_t)(0644u & ~inherited_mask);
  }
  if (write_all(file,r->bytes,r->length) || fchmod(file,publish_mode) || fsync(file)) { error = "IO_ERROR"; goto done; }
  error = snapshot_fd(file,FILE_CAP,out);
  if (error) goto done;
  if (out->length != r->length || (r->length && memcmp(out->bytes,r->bytes,r->length))) { error = "STALE_CONTENT"; goto done; }
  int current_exists = 0;
  error = read_snapshot(parent,leaf,FILE_CAP,&current,&current_exists);
  if (error) goto done;
  if (current_exists != exists || (exists && (!same_meta(&current.meta,&before.meta) || current.length != before.length
    || (before.length && memcmp(current.bytes,before.bytes,before.length))))) { error = !exists ? "CONFLICT" : "STALE_CONTENT"; goto done; }
  if (!exists) {
    if (linkat(stage,"payload",parent,leaf,0)) { error = errno == EEXIST ? "CONFLICT" : "IO_ERROR"; goto done; }
    published = 1;
    if (unlinkat(stage,"payload",0)) { error = "IO_ERROR"; goto done; }
    staged_file = 0; *action = 1;
  } else {
    /* No portable atomic target-CAS exists: the checked entry may change here.
     * renameat never follows the destination or alters its old hardlinked inode. */
    if (renameat(stage,"payload",parent,leaf)) { error = "IO_ERROR"; goto done; }
    published = 1; staged_file = 0; *action = r->policy == 3 ? 3 : 2;
  }
  /* Return actual readback from the same written inode after publication,
   * rather than bytes reread through a potentially substituted target path. */
  free(out->bytes); out->bytes = NULL;
  error = snapshot_fd(file,FILE_CAP,out);
  if (error) goto done;
  if (out->length != r->length || (r->length && memcmp(out->bytes,r->bytes,r->length))) { error = "STALE_CONTENT"; goto done; }
done:
  free(before.bytes); free(current.bytes);
  if (file >= 0) close(file);
  if (stage >= 0) {
    if (staged_file && unlinkat(stage,"payload",0)) { error = "IO_ERROR"; published = 1; }
    struct stat named;
    /* Cleanup only the still-named directory inode we actually opened. */
    if (stage_created && stage_identity && !fstatat(parent,stage_name,&named,AT_SYMLINK_NOFOLLOW)
      && named.st_dev == stage_stat.st_dev && named.st_ino == stage_stat.st_ino) {
      if (unlinkat(parent,stage_name,AT_REMOVEDIR)) { error = "IO_ERROR"; published = 1; }
    } else if (stage_created) { error = "IO_ERROR"; published = 1; }
    close(stage);
  } else if (stage_created) { error = "IO_ERROR"; published = 1; }
  if (!error && published && fsync(parent)) error = "IO_ERROR";
  close(parent);
  if (error) { free(out->bytes); out->bytes = NULL; }
  return error;
}
static int response(const char *error, const unsigned char *payload, uint32_t length) {
  if (error) { error = published ? "PARTIAL_COMMIT" : error; payload = (const unsigned char *)error; length = (uint32_t)strlen(error); }
  unsigned char header[16], *p = header;
  memcpy(p,MAGIC,8); p += 8; put(&p,error ? 1 : 0,2); put(&p,published ? 1 : 0,1); put(&p,0,1); put(&p,length,4);
  return write_all(STDOUT_FILENO,header,sizeof header) || write_all(STDOUT_FILENO,payload,length) ? 1 : 0;
}
int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return response("PROTOCOL_INVALID",NULL,0);
  unsigned char *input = malloc(REQUEST_CAP); if (!input) return response("IO_ERROR",NULL,0);
  size_t length = 0; int overflow = 0;
  unsigned char chunk[16384];
  for (;;) {
    ssize_t n = read(STDIN_FILENO,chunk,sizeof chunk);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { free(input); return response("PROTOCOL_INVALID",NULL,0); }
    if (!n) break;
    if ((size_t)n > REQUEST_CAP - length) overflow = 1;
    else if (!overflow) { memcpy(input + length,chunk,(size_t)n); length += (size_t)n; }
  }
  Request r = {0}; const char *error = overflow ? "PROTOCOL_INVALID" : parse_request(input,length,&r);
  struct stat root;
  if (!error && (fstat(3,&root) || !S_ISDIR(root.st_mode) || (uint64_t)root.st_dev != r.root_dev || (uint64_t)root.st_ino != r.root_ino)) error = "PATH_REFUSED";
  if (error) { free(input); return response(error,NULL,0); }
  if (r.op == 4 || r.op == 5) {
    unsigned char *output = NULL, removed = 0;
    uint32_t output_length = 0;
    if (r.op == 4) error = list_directory(&r,&output,&output_length);
    else {
      error = unlink_file(&r,&removed);
      if (!error) { output = malloc(1); if (!output) error = "IO_ERROR"; else { output[0] = removed; output_length = 1; } }
    }
    int result = response(error,output,output_length);
    free(output); free(input); return result;
  }
  Snapshot s = {0}; unsigned char action = 0; int exists = 0, parent = -1, missing = 0;
  if (!r.op) s.meta = stat_meta(&root);
  else if (r.op == 1) {
    error = directory(&r.path,(uint16_t)(r.path.count - 1),0,&parent,&missing);
    if (!error && !missing) error = read_snapshot(parent,r.path.part[r.path.count - 1],r.cap,&s,&exists);
    if (parent >= 0) close(parent);
  } else if (r.op == 2) error = replace_file(&r,&s,&action);
  else {
    error = directory(&r.path,r.path.count,1,&parent,&missing);
    if (!error) { struct stat st; if (fstat(parent,&st)) error = "IO_ERROR"; else s.meta = stat_meta(&st); }
    if (parent >= 0) close(parent);
  }
  if (error) { free(s.bytes); free(input); return response(error,NULL,0); }
  uint32_t output_length = r.op == 1 ? 1u + (exists ? META_SIZE + 4u + s.length : 0u)
    : r.op == 2 ? 1u + META_SIZE + 4u + s.length : META_SIZE;
  unsigned char *output = malloc(output_length), *p = output;
  if (!output) { free(s.bytes); free(input); return response("IO_ERROR",NULL,0); }
  if (r.op == 1) { put(&p,(uint64_t)exists,1); if (exists) { put_meta(&p,&s.meta); put(&p,s.length,4); if (s.length) memcpy(p,s.bytes,s.length); } }
  else if (r.op == 2) { put(&p,action,1); put_meta(&p,&s.meta); put(&p,s.length,4); if (s.length) memcpy(p,s.bytes,s.length); }
  else put_meta(&p,&s.meta);
  int result = response(NULL,output,output_length);
  free(output); free(s.bytes); free(input); return result;
}
