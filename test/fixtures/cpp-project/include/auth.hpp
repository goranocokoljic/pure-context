#pragma once
#include <string>
#include <memory>
#include <stdexcept>

namespace Auth {

// Maximum session duration in seconds.
#define AUTH_MAX_SESSION_SECS 3600

// Forward declaration.
class SessionStore;

/// Exception thrown on authentication failure.
class AuthException : public std::runtime_error {
public:
    explicit AuthException(const std::string& msg) : std::runtime_error(msg) {}
};

/// Represents an authenticated user session.
struct Session {
    std::string userId;
    std::string username;
    long long   expiresAt;
};

using TokenString = std::string;

/// Template cache for storing arbitrary session data.
template<typename T>
class Cache {
public:
    Cache() = default;
    explicit Cache(size_t capacity);

    void   set(const std::string& key, const T& value);
    bool   get(const std::string& key, T& out) const;
    void   evict(const std::string& key);
    size_t size() const;

private:
    size_t _capacity = 0;
    bool   _validate(const std::string& key) const;
};

/// Manages authentication for a service.
class AuthService {
public:
    AuthService(const std::string& apiUrl, int timeoutMs = 5000);
    ~AuthService();

    /// Authenticate with username and password.
    bool login(const std::string& username, const std::string& password);

    /// End the current session.
    void logout(const TokenString& token);

    /// Return the session for a valid token.
    Session getSession(const TokenString& token) const;

    /// Check whether a token is still valid.
    bool isValid(const TokenString& token) const;

    AuthService(const AuthService&) = delete;
    AuthService& operator=(const AuthService&) = delete;

private:
    std::string _apiUrl;
    int         _timeoutMs;
    bool        _validateCredentials(const std::string& user, const std::string& pass) const;
};

}  // namespace Auth
