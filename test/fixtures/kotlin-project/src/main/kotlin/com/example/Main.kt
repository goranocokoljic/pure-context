package com.example

import io.ktor.server.application.Application
import io.ktor.server.engine.embeddedServer

/** Maximum number of connections. */
val MAX_CONNECTIONS: Int = 100

val internalOnly = "not a public const"

// A standalone greeting function
fun greet(name: String): String = "Hello, $name!"

fun buildApp(config: Map<String, String>): String = config.toString()

typealias UserId = Long
typealias ConfigMap = Map<String, String>

interface Repository<T> {
    fun findById(id: Long): T?
    fun save(entity: T): T
}

object AppRegistry {
    fun register(name: String) {}
    fun lookup(name: String): String? = null
}

sealed class Result<out T> {
    data class Success<T>(val value: T) : Result<T>()
    data class Failure(val error: Throwable) : Result<Nothing>()
}

enum class Status {
    ACTIVE,
    INACTIVE,
    PENDING,
}
