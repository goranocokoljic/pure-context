import Foundation

/// Thread-safe token storage using Swift actors.
public actor TokenStore {
    private var tokens: [String: Date] = [:]

    /// Stores a token with an expiry date.
    public func store(token: String, expiry: Date) {
        tokens[token] = expiry
    }

    /// Returns true if the token is valid and not expired.
    public func isValid(token: String) -> Bool {
        guard let expiry = tokens[token] else { return false }
        return expiry > Date()
    }

    /// Removes an expired or revoked token.
    public func revoke(token: String) {
        tokens.removeValue(forKey: token)
    }
}
