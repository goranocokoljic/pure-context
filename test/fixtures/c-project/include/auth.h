#ifndef AUTH_H
#define AUTH_H

#include <stdint.h>
#include "types.h"

/* Maximum length for usernames and passwords. */
#define MAX_USERNAME_LEN 64
#define MAX_PASSWORD_LEN 128

/* Authentication result codes. */
typedef enum {
    AUTH_OK = 0,
    AUTH_ERR_INVALID_CREDENTIALS,
    AUTH_ERR_ACCOUNT_LOCKED,
    AUTH_ERR_EXPIRED,
} AuthResult;

/* Represents an authenticated user session. */
typedef struct {
    uint32_t user_id;
    char username[MAX_USERNAME_LEN];
    uint64_t expires_at;
    int is_admin;
} AuthSession;

/* Opaque handle for the authentication context. */
typedef struct AuthContext AuthContext;

/* Token type alias. */
typedef char * AuthToken;

/* Create a new authentication context. Returns NULL on failure. */
AuthContext *auth_create(const char *db_path);

/* Destroy an authentication context and free resources. */
void auth_destroy(AuthContext *ctx);

/* Attempt to authenticate a user. Returns AUTH_OK on success. */
AuthResult auth_login(AuthContext *ctx, const char *username, const char *password, AuthSession *out_session);

/* Validate a session token. Returns 1 if valid, 0 otherwise. */
int auth_validate_token(AuthContext *ctx, const char *token, AuthSession *out_session);

/* Revoke an active session. */
void auth_logout(AuthContext *ctx, const char *token);

/* Returns a pointer to the current username for a session. */
const char *auth_get_username(const AuthSession *session);

#endif /* AUTH_H */
