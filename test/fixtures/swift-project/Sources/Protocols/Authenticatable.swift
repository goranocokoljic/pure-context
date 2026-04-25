import Foundation

/// Defines the contract for authenticatable entities.
public protocol Authenticatable {
    var username: String { get }
    var email: String { get }
    func authenticate(password: String) async throws -> Bool
    func resetPassword(newPassword: String) async throws
}

/// Protocol for objects that can be serialized to a token.
public protocol TokenSerializable {
    func toToken() -> String
    init?(token: String)
}
