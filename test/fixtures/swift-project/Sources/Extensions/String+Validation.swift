import Foundation

/// Validation helpers for String.
extension String {

    /// Returns true if the string is a valid email address.
    public var isValidEmail: Bool {
        return contains("@") && contains(".")
    }

    /// Returns true if the string meets password requirements.
    public var isValidPassword: Bool {
        return count >= 8
    }

    /// Sanitises the string for safe display.
    public func sanitised() -> String {
        return trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
