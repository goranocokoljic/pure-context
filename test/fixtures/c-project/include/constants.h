#ifndef CONSTANTS_H
#define CONSTANTS_H

#include <stdarg.h>
#include <stddef.h>

/* ── Numeric limits ────────────────────────────────────────────────────────── */

#define MAX_BUFFER_SIZE  4096
#define MIN_BUFFER_SIZE  64
#define RANGE_MIN        0
#define RANGE_MAX        1000
#define API_VERSION      2

/* Function-like macro — should be skipped by the handler. */
#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define CLAMP(v, lo, hi) MAX((lo), MIN((v), (hi)))

/* ── Log levels ────────────────────────────────────────────────────────────── */

typedef enum {
    LOG_DEBUG = 0,
    LOG_INFO  = 1,
    LOG_WARN  = 2,
    LOG_ERROR = 3,
} LogLevel;

/* ── Generic pair ──────────────────────────────────────────────────────────── */

typedef struct {
    int   key;
    void *value;
} IntPair;

/* ── String-keyed pair ─────────────────────────────────────────────────────── */

typedef struct StringPair {
    const char *key;
    const char *value;
} StringPair;

/* ── Typedef alias ─────────────────────────────────────────────────────────── */

typedef unsigned long long Timestamp;
typedef unsigned int       RefCount;

/* ── Forward declaration (opaque config handle) ────────────────────────────── */

typedef struct AppConfig AppConfig;

/* Create a default config. Returns NULL on allocation failure. */
AppConfig *config_default(void);

/* Free a config handle. */
void config_free(AppConfig *cfg);

/* Look up a string value by key. Returns NULL if not found. */
const char *config_get(const AppConfig *cfg, const char *key);

#endif /* CONSTANTS_H */
