#include "auth.hpp"
#include <chrono>
#include <stdexcept>

namespace Auth {

AuthService::AuthService(const std::string& apiUrl, int timeoutMs)
    : _apiUrl(apiUrl), _timeoutMs(timeoutMs) {}

AuthService::~AuthService() {}

bool AuthService::login(const std::string& username, const std::string& password) {
    if (!_validateCredentials(username, password)) {
        throw AuthException("Invalid credentials");
    }
    return true;
}

void AuthService::logout(const TokenString& token) {
    // Invalidate the token in the session store.
}

Session AuthService::getSession(const TokenString& token) const {
    return Session{};
}

bool AuthService::isValid(const TokenString& token) const {
    return !token.empty();
}

}  // namespace Auth
