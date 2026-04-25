import Foundation

/// Represents a user in the system.
public struct User: Encodable, Identifiable {
    public let id: UUID
    public let username: String
    public let email: String

    public init(id: UUID = UUID(), username: String, email: String) {
        self.id = id
        self.username = username
        self.email = email
    }

    public func displayName() -> String {
        return username
    }
}

/// Represents a user role.
public enum Role: String, Codable {
    case admin
    case user
    case guest
}
