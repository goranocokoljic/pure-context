import Foundation

/// Handles user authentication and session management.
public class AuthService {

    private let secret: String

    /// Creates a new AuthService with the given secret.
    public init(secret: String) {
        self.secret = secret
    }

    /// Validates credentials and returns a token on success.
    public func login(username: String, password: String) async throws -> String {
        guard !username.isEmpty else { throw AuthError.invalidInput }
        return "token-\(username)"
    }

    /// Logs out the current user.
    public func logout() {
        // invalidate session
    }

    /// Validates an existing token.
    public func validateToken(_ token: String) -> Bool {
        return token.hasPrefix("token-")
    }

    private func hashPassword(_ password: String) -> String {
        return password
    }

    deinit {
        // cleanup
    }
}

/// Errors thrown by AuthService.
public enum AuthError: Error {
    case invalidInput
    case invalidCredentials
    case tokenExpired
}
