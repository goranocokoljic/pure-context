#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "../include/constants.h"

/* Internal: clamp a value within [min, max]. */
static int clamp(int value, int min, int max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/* Internal: check if a string is empty or NULL. */
static int str_is_empty(const char *s) {
    return s == NULL || s[0] == '\0';
}

/* Internal: reverse a string in place. */
static void str_reverse(char *s, size_t len) {
    size_t i = 0, j = len - 1;
    while (i < j) {
        char tmp = s[i];
        s[i] = s[j];
        s[j] = tmp;
        i++;
        j--;
    }
}

/* Clamp an integer to the application-defined safe range. */
int util_clamp_int(int value) {
    return clamp(value, RANGE_MIN, RANGE_MAX);
}

/* Copy src into dest, truncating at max_len bytes. Always NUL-terminates dest.
   Returns the number of characters written (excluding the NUL). */
size_t util_safe_copy(char *dest, const char *src, size_t max_len) {
    if (!dest || max_len == 0) return 0;
    if (str_is_empty(src)) {
        dest[0] = '\0';
        return 0;
    }
    size_t n = strnlen(src, max_len - 1);
    memcpy(dest, src, n);
    dest[n] = '\0';
    return n;
}

/* Return a newly allocated reversed copy of str. Caller must free the result. */
char *util_strrev(const char *str) {
    if (!str) return NULL;
    size_t len = strlen(str);
    char *copy = (char *)malloc(len + 1);
    if (!copy) return NULL;
    memcpy(copy, str, len + 1);
    str_reverse(copy, len);
    return copy;
}

/* Variadic helper: print a formatted message with a severity prefix. */
void util_log(LogLevel level, const char *fmt, ...) {
    const char *prefix = level == LOG_ERROR ? "ERROR" : level == LOG_WARN ? "WARN" : "INFO";
    fprintf(stderr, "[%s] ", prefix);
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
    fputc('\n', stderr);
}
