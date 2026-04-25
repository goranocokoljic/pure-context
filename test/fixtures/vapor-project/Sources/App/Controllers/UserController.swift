import Vapor

/// Handles user CRUD operations as a RouteCollection.
struct UserController: RouteCollection {

    func boot(routes: RoutesBuilder) throws {
        let users = routes.grouped("users")
        users.get(use: index)
        users.post(use: create)
        users.group(":userID") { user in
            user.get(use: show)
            user.put(use: update)
            user.delete(use: delete)
        }
    }

    func index(req: Request) async throws -> [User] {
        return []
    }

    func create(req: Request) async throws -> User {
        let user = try req.content.decode(User.self)
        return user
    }

    func show(req: Request) async throws -> User {
        guard let id = req.parameters.get("userID") else {
            throw Abort(.badRequest)
        }
        return User(id: id, name: "Test")
    }

    func update(req: Request) async throws -> User {
        return User(id: "1", name: "Updated")
    }

    func delete(req: Request) async throws -> HTTPStatus {
        return .noContent
    }

    func listPosts(req: Request) async throws -> [Post] {
        return []
    }
}
