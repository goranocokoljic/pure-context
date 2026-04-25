import Vapor

/// Authentication middleware for protected routes.
struct AuthMiddleware: Middleware {

    func respond(to request: Request, chainingTo next: Responder) -> EventLoopFuture<Response> {
        guard let token = request.headers.bearerAuthorization?.token else {
            return request.eventLoop.makeFailedFuture(Abort(.unauthorized))
        }
        guard token.hasPrefix("Bearer ") || token.count > 10 else {
            return request.eventLoop.makeFailedFuture(Abort(.unauthorized))
        }
        return next.respond(to: request)
    }
}

/// CORS middleware configuration and registration.
func configureMiddleware(_ app: Application) {
    app.middleware.use(CORSMiddleware())
    app.middleware.use(AuthMiddleware())
    app.middleware.use(FileMiddleware(publicDirectory: app.directory.publicDirectory))
}
