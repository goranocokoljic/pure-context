package com.example

import io.ktor.server.application.*
import io.ktor.server.auth.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.routing.*
import io.ktor.server.response.*

fun main() {
    embeddedServer(Netty, port = 8080, host = "0.0.0.0", module = Application::module).start(wait = true)
}

fun Application.module() {
    configureRouting()
}

fun Application.configureRouting() {
    routing {
        get("/health") {
            call.respondText("OK")
        }

        route("/api") {
            get("/users") {
                call.respondText("list users")
            }
            post("/users") {
                call.respondText("create user")
            }
            get("/users/{id}") {
                call.respondText("get user")
            }
            put("/users/{id}") {
                call.respondText("update user")
            }
            delete("/users/{id}") {
                call.respondText("delete user")
            }

            authenticate("jwt") {
                get("/profile") {
                    call.respondText("profile")
                }
                post("/logout") {
                    call.respondText("logout")
                }
            }
        }

        route("/v1") {
            route("/items") {
                get("/") {
                    call.respondText("list items")
                }
                get("/{id}") {
                    call.respondText("get item")
                }
                post("/") {
                    call.respondText("create item")
                }
            }
        }
    }
}
