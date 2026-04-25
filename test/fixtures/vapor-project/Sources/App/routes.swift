import Vapor

func routes(_ app: Application) throws {
    // Health check
    app.get("health") { req in
        return "OK"
    }

    // User routes
    app.get("users", use: UserController().index)
    app.post("users", use: UserController().create)
    app.get("users", ":id", use: UserController().show)
    app.put("users", ":id", use: UserController().update)
    app.delete("users", ":id", use: UserController().delete)

    // Nested resource: user posts
    app.get("users", ":userId", "posts", use: UserController().listPosts)

    // WebSocket endpoint
    app.webSocket("ws", "chat", onUpgrade: chatHandler)

    // Versioned API group
    let v1 = app.grouped("api", "v1")
    v1.get("status", use: statusHandler)

    // Register route collection
    try app.register(collection: UserController())
}
